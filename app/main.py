"""StoryCraft video maker: local web server. Run with `python -m app.main` (or start.bat)."""
import hashlib
import json
import os
import re
import socket
import subprocess
import threading
import traceback
import webbrowser
from pathlib import Path

import soundfile as sf
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import dialogs
from . import config as config_module
from .config import CONFIG, MEDIA_DIR, PROJECTS_DIR, ROOT, WORKSPACE
from .render import (AUDIO_DIR, DEFAULT_SETTINGS, MOTIONS, PREVIEW_DIR, Job, RenderError,
                     build_timeline, cache_info, cleanup_cache, clear_video_cache, merged_settings,
                     narrate, render, scene_summary, trim_segments)
from .tts import SAMPLE_RATE, Cancelled, Narrator

STATIC = Path(__file__).resolve().parent / "static"
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp"}

app = FastAPI(title="StoryCraft")
app.mount("/static", StaticFiles(directory=STATIC), name="static")
APP_DIR = Path(__file__).resolve().parent


def _code_mtime():
    return max(p.stat().st_mtime for p in APP_DIR.glob("*.py"))


STARTED_CODE_MTIME = _code_mtime()


@app.middleware("http")
async def no_stale_static(request, call_next):
    # Always revalidate page files so the browser never mixes old and new versions.
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response
def make_narrator():
    return Narrator(CONFIG["kokoro_model"], CONFIG["kokoro_voices"], WORKSPACE / "cache" / "tts",
                    torch_dir=CONFIG.get("kokoro_torch_dir", ""), engine=CONFIG.get("kokoro_engine", "auto"))


narrator = make_narrator()
jobs = {}
current = {"job": None}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/api/status")
def status():
    voices = narrator.voices()
    defaults = json.loads(json.dumps(DEFAULT_SETTINGS))
    if voices and defaults["voice"]["voice"] not in {v["id"] for v in voices}:
        defaults["voice"]["voice"] = voices[0]["id"]
    return {"kokoro_error": narrator.check(), "kokoro_engine": narrator.engine_label,
            "ffmpeg": CONFIG.get("ffmpeg") or None,
            "voices": voices, "defaults": defaults, "motions": MOTIONS, "fonts": list_fonts(),
            "projects_dir": str(PROJECTS_DIR), "config_file": str(ROOT / "config.json"),
            "restart_needed": _code_mtime() > STARTED_CODE_MTIME}


def list_fonts():
    import winreg
    names = set()
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            key = winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")
        except OSError:
            continue
        for i in range(winreg.QueryInfoKey(key)[1]):
            name = winreg.EnumValue(key, i)[0]
            name = re.sub(r"\s*\((TrueType|OpenType|All res)\)$", "", name)
            for part in name.split(" & "):
                part = re.sub(r"\s+(Bold|Italic|Bold Italic|Regular|Light|Semibold|SemiBold)$", "", part)
                if part and not part.startswith("@"):
                    names.add(part.strip())
    return sorted(names, key=str.lower)


# ---- images ----------------------------------------------------------------------------------
@app.post("/api/upload")
async def upload(files: list[UploadFile]):
    """Store a copy of each uploaded image in media/ (content-addressed). Originals are untouched."""
    saved = []
    for f in files:
        suffix = Path(f.filename or "").suffix.lower()
        if suffix not in IMAGE_TYPES:
            raise HTTPException(400, f"{f.filename}: only PNG, JPG and WebP images are supported.")
        data = await f.read()
        digest = hashlib.sha1(data).hexdigest()[:16]
        safe = re.sub(r"[^\w.\- ]", "_", Path(f.filename).name)
        target = MEDIA_DIR / f"{digest}_{safe}"
        if not target.exists():
            target.write_bytes(data)
        saved.append({"path": str(target), "name": Path(f.filename).name})
    return saved


@app.get("/api/image")
def image(path: str):
    p = Path(path)
    if p.suffix.lower() not in IMAGE_TYPES or not p.is_file():
        raise HTTPException(404, "Image not found")
    return FileResponse(p)


@app.post("/api/check_images")
def check_images(body: dict):
    """Missing images, plus automatic fixes for images that are in this app's media folder
    (e.g. after the app folder was copied to another PC or renamed)."""
    missing, relinked = [], {}
    for p in body.get("paths", []):
        if p and Path(p).is_file():
            continue
        fixed = relink(p)
        if fixed:
            relinked[p] = fixed
        else:
            missing.append(p)
    return {"missing": missing, "relinked": relinked}


def relink(path):
    """Find a moved image: same file name inside this app's media/ folder."""
    if not path:
        return None
    from pathlib import PureWindowsPath
    candidate = MEDIA_DIR / PureWindowsPath(path).name
    return str(candidate) if candidate.is_file() else None


# ---- narration -------------------------------------------------------------------------------
def _require_kokoro():
    problem = narrator.check()
    if problem:
        raise HTTPException(500, problem)


@app.post("/api/scene_audio")
def scene_audio(body: dict):
    """Narrate one scene (cached) so it can be played on its own."""
    _require_kokoro()
    project, index = body["project"], int(body["index"])
    scene = project["scenes"][index]
    if not (scene.get("script") or "").strip():
        raise HTTPException(400, "This scene has no narration script yet.")
    single = {**project, "scenes": [scene]}
    try:
        item = narrate(single, narrator, Job("scene"))[0]
    except RenderError as e:
        raise HTTPException(400, str(e))
    tl = build_timeline(single, [item])
    return scene_summary(tl)[0]


@app.post("/api/test_voice")
def test_voice(body: dict):
    _require_kokoro()
    voice, speed = body.get("voice"), float(body.get("speed", 1.0))
    text = (body.get("text") or "").strip() or \
        "At 8:43 PM, the world was about to end. Unfortunately, you had absolutely no idea."
    audio, _, _ = narrator.scene(text, voice, speed)
    name = "test_" + hashlib.sha1(f"{voice}{speed}{text}".encode()).hexdigest()[:16] + ".wav"
    sf.write(str(AUDIO_DIR / name), audio, SAMPLE_RATE)
    return {"audio_url": f"/api/audio/{name}", "duration": round(len(audio) / SAMPLE_RATE, 2)}


@app.get("/api/audio/{name}")
def audio_file(name: str):
    p = AUDIO_DIR / Path(name).name
    if not p.is_file():
        raise HTTPException(404, "Audio not found")
    return FileResponse(p, media_type="audio/wav")


# ---- jobs (narrate / preview / export) -------------------------------------------------------
def _run_job(job, project):
    try:
        if job.kind == "narrate":
            scenes = project.get("scenes") or []
            if not scenes:
                raise RenderError("Add at least one scene.")
            empty = [str(i) for i, s in enumerate(scenes, 1) if not (s.get("script") or "").strip()]
            if empty:
                raise RenderError("These scenes have no narration script: " + ", ".join(empty))
            tl = build_timeline(project, narrate(project, narrator, job))
            job.result = {"scenes": scene_summary(tl), "duration": round(tl["total"], 3)}
        else:
            preview = job.kind == "preview"
            result = render(project, narrator, job, preview=preview)
            if preview:
                result["url"] = f"/api/preview/{Path(result['path']).name}"
            job.result = result
        job.update("Done", 1.0)
        job.state = "done"
    except Cancelled:
        job.state, job.stage = "cancelled", "Cancelled"
    except RenderError as e:
        job.state, job.error = "error", str(e)
    except Exception as e:  # unexpected: keep the details for the user instead of failing silently
        traceback.print_exc()
        job.state, job.error = "error", f"{type(e).__name__}: {e}"
    finally:
        if job.kind != "narrate":
            trim_segments()


@app.post("/api/jobs")
def start_job(body: dict):
    kind = body.get("kind")
    if kind not in ("narrate", "preview", "export"):
        raise HTTPException(400, "Unknown job")
    _require_kokoro()
    running = current["job"]
    if running and running.state == "running":
        raise HTTPException(409, "Another task is still running. Wait for it or cancel it.")
    job = Job(kind)
    jobs[job.id] = job
    current["job"] = job
    threading.Thread(target=_run_job, args=(job, body["project"]), daemon=True).start()
    return job.to_dict()


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Unknown job")
    return jobs[job_id].to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    if job_id in jobs:
        jobs[job_id].cancel()
    return {"ok": True}


@app.get("/api/cache")
def cache_status():
    return cache_info()


@app.post("/api/cache/clear")
def cache_clear():
    running = current["job"]
    if running and running.state == "running":
        raise HTTPException(409, "Wait for the current task to finish before clearing the cache.")
    clear_video_cache()
    return cache_info()


@app.get("/api/preview/{name}")
def preview_file(name: str):
    p = PREVIEW_DIR / Path(name).name
    if not p.is_file():
        raise HTTPException(404, "Preview not found")
    return FileResponse(p, media_type="video/mp4")


# ---- projects & dialogs ----------------------------------------------------------------------
@app.post("/api/project/save")
def save_project(body: dict):
    project, path = body["project"], body.get("path")
    if not path or body.get("save_as"):
        name = (project.get("name") or "StoryCraft").strip() or "StoryCraft"
        path = dialogs.ask("save", title="Save project", initialdir=str(PROJECTS_DIR),
                           initialfile=f"{name}.storycraft.json", defaultextension=".json",
                           filetypes=[["StoryCraft project", "*.json"]])
        if not path:
            return {"path": None}
    project = {**project, "version": 1}
    tmp = Path(path).with_suffix(".tmp")
    tmp.write_text(json.dumps(project, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    return {"path": str(Path(path))}


@app.post("/api/project/open")
def open_project(body: dict):
    path = body.get("path") or dialogs.ask("open", title="Open project", initialdir=str(PROJECTS_DIR),
                                           filetypes=[["StoryCraft project", "*.json"]])
    if not path:
        return {"path": None}
    try:
        project = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise HTTPException(400, f"Could not open project: {e}")
    if not isinstance(project.get("scenes"), list):
        raise HTTPException(400, "This file is not a StoryCraft project.")
    project["settings"] = merged_settings(project)
    missing, relinked = [], 0
    for scene in project["scenes"]:
        image = scene.get("image")
        if image and Path(image).is_file():
            continue
        fixed = relink(image)
        if fixed:
            scene["image"], relinked = fixed, relinked + 1
        else:
            missing.append(image)
    return {"path": path, "project": project, "missing": missing, "relinked": relinked}


@app.post("/api/setup/locate")
def setup_locate(body: dict):
    """Let the user point to Kokoro or FFmpeg when auto-detection failed; saved in config.json."""
    global narrator
    kind = body.get("kind")
    if kind == "ffmpeg":
        path = dialogs.ask("open", title="Locate ffmpeg.exe", filetypes=[["ffmpeg.exe", "ffmpeg.exe"]])
        if not path:
            return {"ok": False}
        probe = Path(path).with_name("ffprobe.exe")
        if not probe.exists():
            raise HTTPException(400, "ffprobe.exe must be in the same folder as ffmpeg.exe.")
        CONFIG.update(ffmpeg=str(Path(path)), ffprobe=str(probe))
    elif kind == "kokoro":
        path = dialogs.ask("open", title="Locate the Kokoro model file",
                           filetypes=[["Kokoro model", "kokoro-v1.0.onnx kokoro-v1_0.pth"], ["All files", "*.*"]])
        if not path:
            return {"ok": False}
        p = Path(path)
        if p.name.endswith(".onnx"):
            voices = p.with_name("voices-v1.0.bin")
            if not voices.exists():
                raise HTTPException(400, "voices-v1.0.bin must be in the same folder as the .onnx model.")
            CONFIG.update(kokoro_engine="onnx", kokoro_model=str(p), kokoro_voices=str(voices), kokoro_torch_dir="")
        elif p.name.endswith(".pth"):
            CONFIG.update(kokoro_engine="torch", kokoro_torch_dir=str(p.parent), kokoro_model="", kokoro_voices="")
        else:
            raise HTTPException(400, "Choose kokoro-v1.0.onnx (ONNX) or kokoro-v1_0.pth (PyTorch / Kokoro-82M).")
        narrator = make_narrator()
    else:
        raise HTTPException(400, "Unknown setup item")
    config_module.save(CONFIG)
    return {"ok": True}


@app.post("/api/dialog/folder")
def choose_folder(body: dict):
    return {"path": dialogs.ask("folder", title="Choose output folder",
                                initialdir=body.get("initial") or str(ROOT)) or None}


@app.post("/api/reveal")
def reveal(body: dict):
    p = Path(body.get("path", ""))
    if p.is_file():
        subprocess.Popen(["explorer", "/select,", str(p)])
    elif p.is_dir():
        os.startfile(str(p))
    return {"ok": True}


def main():
    port = int(CONFIG.get("port", 8765))
    url = f"http://127.0.0.1:{port}"
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:     # already running: just open it
            print(f"StoryCraft is already running at {url}")
            if not os.environ.get("STORYCRAFT_NO_BROWSER"):
                webbrowser.open(url)
            return
    cleanup_cache()
    if not os.environ.get("STORYCRAFT_NO_BROWSER"):
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    import uvicorn
    print(f"StoryCraft is running at {url}  (close this window to stop)")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
