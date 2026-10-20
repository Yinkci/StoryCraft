"""StoryCraft video maker: local web server. Run with `python -m app.main` (or start.bat)."""
import hashlib
import json
import os
import re
import shutil
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

from . import dialogs, imagegen
from . import config as config_module
from .config import ARTSTYLE_DIR, CONFIG, MEDIA_DIR, PROJECTS_DIR, ROOT, WORKSPACE
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


# ---- series style: characters + art style shared by all projects -----------------------------------
SERIES_FILE = ROOT / "series_style.json"
RECOMMENDED_STYLE = 'Flat 2D webcomic style, like animated storytelling channels on YouTube. Simple shapes and clean dark outlines of even thickness. Flat colors with at most one soft shadow tone; no gradients, textures or glossy highlights. Muted, slightly desaturated natural palette (greys, greens, browns, dusty blues). Plain, even lighting (overcast daylight or ordinary indoor light). Simple backgrounds in the same flat style, everything in focus. Characters are simple cartoon people with round heads, small dot eyes, simple eyebrows and small mouths, wearing plain clothes; emotions are shown with eyebrows, small mouth shapes and body language, never with exaggerated anime faces. Calm, readable poses.'
RECOMMENDED_AVOID = 'realistic humans, photorealism, photographs, 3D render, anime or manga style, painterly or highly detailed rendering, cinematic or dramatic lighting, glowing light sources, light rays, lens flare, bokeh, depth-of-field blur, rain or wet reflections, neon, oversaturated colors, detailed textures, exaggerated anime faces or huge open screaming mouths'
DEFAULT_SERIES = {"style": RECOMMENDED_STYLE, "avoid": RECOMMENDED_AVOID,
                  "style_images": [], "characters": []}


def _fix_paths(paths):
    out = []
    for p in paths or []:
        if p and Path(p).is_file():
            out.append(p)
        elif relink(p):
            out.append(relink(p))
    return out


# ---- art style folder: every image in artstyle/ is a style example; artstyle/rules.txt adds rules ----
ART_TYPES = {".png", ".jpg", ".jpeg", ".webp"}


def _migrate_style_settings():
    """One time: earlier versions kept the art style in settings. Move custom rules into rules.txt and
    old style example images into the folder, so nothing is lost."""
    if not SERIES_FILE.exists():
        return
    try:
        data = json.loads(SERIES_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if data.get("style_migrated"):
        return
    rules = ARTSTYLE_DIR / "rules.txt"
    lines = []
    style = (data.get("style") or "").strip()
    if style and style != RECOMMENDED_STYLE:
        for sentence in re.findall(r"[^.!?]+[.!?]?", style):
            sentence = sentence.strip()
            if sentence and sentence not in RECOMMENDED_STYLE and "follow the style of the character" not in sentence.lower():
                lines.append(sentence)
    known = {x.strip().lower() for x in RECOMMENDED_AVOID.split(",")} | {"detailed realistic faces"}
    extra = [x.strip() for x in re.split(r"[,;]", data.get("avoid") or "") if x.strip() and x.strip().lower() not in known]
    if extra:
        lines.append("Never draw: " + ", ".join(extra) + ".")
    if lines and not rules.exists():
        rules.write_text("# Extra rules added to every image prompt (one per line). Lines starting with # are ignored.\n"
                         + "\n".join(lines) + "\n", encoding="utf-8")
    if not any(p.suffix.lower() in ART_TYPES for p in ARTSTYLE_DIR.iterdir()):
        for p in _fix_paths(data.get("style_images")):
            shutil.copy2(p, ARTSTYLE_DIR / Path(p).name)
    data["style_migrated"] = True
    SERIES_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


@app.get("/api/artstyle")
def artstyle():
    _migrate_style_settings()
    images = sorted((p for p in ARTSTYLE_DIR.iterdir() if p.is_file() and p.suffix.lower() in ART_TYPES),
                    key=lambda p: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)])
    rules_file = ARTSTYLE_DIR / "rules.txt"
    rules = rules_file.read_text(encoding="utf-8", errors="replace") if rules_file.exists() else ""
    return {"folder": str(ARTSTYLE_DIR), "images": [str(p) for p in images],
            "rules": [l.strip() for l in rules.splitlines() if l.strip() and not l.strip().startswith("#")],
            "style": RECOMMENDED_STYLE, "avoid": RECOMMENDED_AVOID}


@app.post("/api/artstyle/open")
def artstyle_open():
    os.startfile(str(ARTSTYLE_DIR))
    return {"ok": True}


@app.get("/api/series_style/recommended")
def recommended_series_style():
    return {"style": RECOMMENDED_STYLE, "avoid": RECOMMENDED_AVOID}


@app.get("/api/series_style")
def get_series_style():
    data = dict(DEFAULT_SERIES)
    if SERIES_FILE.exists():
        try:
            data.update(json.loads(SERIES_FILE.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
    data["style_images"] = _fix_paths(data.get("style_images"))
    for c in data.get("characters", []):
        c["images"] = _fix_paths(c.get("images"))
    return data


@app.post("/api/series_style")
def save_series_style(body: dict):
    clean = {"style": str(body.get("style", ""))[:4000], "avoid": str(body.get("avoid", ""))[:2000],
             "style_images": [str(p) for p in body.get("style_images", [])][:4], "characters": [],
             "style_migrated": bool(body.get("style_migrated", True))}
    for c in body.get("characters", [])[:8]:
        clean["characters"].append({"id": str(c.get("id", ""))[:40], "name": str(c.get("name", ""))[:80],
                                    "description": str(c.get("description", ""))[:600], "main": bool(c.get("main")),
                                    "images": [str(p) for p in c.get("images", [])][:2]})
    tmp = SERIES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(clean, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(SERIES_FILE)
    return {"ok": True}


# ---- scene images with ChatGPT (Codex CLI signed in with ChatGPT) ----------------------------------
image_jobs = {}
image_current = {"job": None}


@app.get("/api/imagegen/models")
def imagegen_models(force: bool = False):
    available = imagegen.models(force=force)
    return {"models": available, "chosen": imagegen.chosen_model() or "",
            "default": available[0]["name"] if available else ""}


@app.post("/api/imagegen/model")
def imagegen_set_model(body: dict):
    slug = str(body.get("model") or "")
    if slug and not any(m["slug"] == slug for m in imagegen.models()):
        raise HTTPException(400, "That model isn't offered by your Codex.")
    CONFIG["image_model"] = slug
    config_module.save(CONFIG)
    return {"chosen": slug}


@app.get("/api/imagegen/status")
def imagegen_status(force: bool = False):
    s = imagegen.status(force=force)
    return {k: s[k] for k in ("ready", "version", "message")}


def _run_image_job(job, body):
    try:
        job.update("Starting Codex…", 0.05)
        path = imagegen.generate(body.get("prompt", ""), bool(body.get("landscape")), body.get("references") or [],
                                 cancelled=job.cancelled, on_progress=lambda m: job.update(m, 0.3))
        job.result = {"path": path, "name": Path(path).name}
        job.update("Done", 1.0)
        job.state = "done"
    except imagegen.Cancelled:
        job.state, job.stage = "cancelled", "Cancelled"
    except imagegen.ImageError as e:
        job.state, job.error = "error", str(e)
    except Exception as e:
        traceback.print_exc()
        job.state, job.error = "error", f"{type(e).__name__}: {e}"


@app.post("/api/imagegen/jobs")
def imagegen_start(body: dict):
    if not (body.get("prompt") or "").strip():
        raise HTTPException(400, "The image prompt is empty.")
    running = image_current["job"]
    if running and running.state == "running":
        raise HTTPException(409, "Another image is still being generated. Wait for it or cancel it.")
    job = Job("image")
    image_jobs[job.id] = job
    image_current["job"] = job
    threading.Thread(target=_run_image_job, args=(job, body), daemon=True).start()
    return job.to_dict()


@app.get("/api/imagegen/jobs/{job_id}")
def imagegen_job(job_id: str):
    if job_id not in image_jobs:
        raise HTTPException(404, "Unknown image job")
    return image_jobs[job_id].to_dict()


@app.post("/api/imagegen/jobs/{job_id}/cancel")
def imagegen_cancel(job_id: str):
    if job_id in image_jobs:
        image_jobs[job_id].cancel()
    return {"ok": True}


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
