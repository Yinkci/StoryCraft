"""Project -> video.

Pipeline: narration per scene (cached) -> frame-exact timeline -> ASS subtitles -> one motion
clip per scene (cached) -> a single FFmpeg pass that joins clips (cut / crossfade / fade through
black), burns subtitles and muxes the narration track.

Timing rule: every scene lasts lead-in + its measured narration + a pause, rounded UP to whole
frames, so audio and video can never drift apart. Transitions happen entirely inside the pause
at the end of a scene, so they never overlap or clip speech.
"""
import hashlib
import json
import math
import random
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import CONFIG, EXPORTS_DIR, WORKSPACE
from .tts import SAMPLE_RATE, Cancelled
from .captions import title_has_text, write_ass

SEGMENT_VERSION = 3
CANVAS_SCALE = 3                     # zoom/pan on a 3x canvas so movement is sub-pixel smooth
MOTIONS = ["static", "zoom_in", "zoom_out", "pan_left", "pan_right", "random"]
INTENSITY = {"subtle": 0.07, "medium": 0.12, "strong": 0.18}
QUALITY = {"standard": ("medium", 21), "high": ("medium", 18), "max": ("slow", 16)}
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

SEGMENT_DIR = WORKSPACE / "cache" / "segments"
AUDIO_DIR = WORKSPACE / "cache" / "audio"
PREVIEW_DIR = WORKSPACE / "preview"
JOBS_DIR = WORKSPACE / "jobs"
for _d in (SEGMENT_DIR, AUDIO_DIR, PREVIEW_DIR, JOBS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

DEFAULT_SETTINGS = {
    "voice": {"voice": "am_liam", "speed": 1.0},
    "timing": {"lead_in": 0.15, "scene_pause": 0.3, "sentence_pause": 0.2, "end_hold": 1.0},
    "subtitles": {"enabled": True, "font": "Arial Black", "size": 84, "color": "#FFFFFF",
                  "outline_color": "#000000", "outline": 6, "shadow": 2, "bold": True,
                  "uppercase": False, "position": 26, "position_x": 50, "max_width": 84,
                  "words_per_caption": 5},
    "imagegen": {"style": "", "no_text": True, "references": [], "continuity": True},
    "title": {"enabled": False, "lines": [{"text": "", "size": 90, "offset": 0}], "line_spacing": 85, "font": "Impact", "color": "#FFFFFF",
              "highlight": "#FF8A1F", "outline": 4, "outline_color": "#000000", "shadow": 2, "bold": False,
              "uppercase": True, "position_x": 50, "position_y": 5, "duration": 0},
    "watermark": {"enabled": False, "text": "", "font": "Arial", "size": 40, "color": "#FFFFFF",
                  "opacity": 70, "outline": 2, "outline_color": "#000000", "shadow": 1, "bold": True,
                  "anchor": "br", "position_x": 96, "position_y": 96},
    "motion": {"default": "random", "intensity": "subtle", "fit": "contain"},
    "transition": {"type": "cut", "duration": 0.4},
    "export": {"output_dir": str(EXPORTS_DIR), "filename": "", "resolution": "1080x1920",
               "fps": 30, "quality": "high"},
}


class RenderError(Exception):
    pass


def merged_settings(project):
    """Project settings with defaults filled in for anything missing."""
    given = project.get("settings") or {}
    out = {}
    for section, defaults in DEFAULT_SETTINGS.items():
        out[section] = {**defaults, **(given.get(section) or {})}
    return out


# ---- jobs ------------------------------------------------------------------------------------
class Job:
    def __init__(self, kind):
        self.id = uuid.uuid4().hex[:10]
        self.kind = kind
        self.state = "running"          # running | done | error | cancelled
        self.stage = "Starting…"
        self.progress = 0.0
        self.error = None
        self.result = None
        self.started = time.time()
        self.proc = None
        self._cancel = threading.Event()

    def update(self, stage=None, progress=None):
        if stage is not None:
            self.stage = stage
        if progress is not None:
            self.progress = max(0.0, min(1.0, progress))

    def cancel(self):
        self._cancel.set()
        proc = self.proc
        if proc and proc.poll() is None:
            proc.kill()

    def cancelled(self):
        return self._cancel.is_set()

    def to_dict(self):
        return {"id": self.id, "kind": self.kind, "state": self.state, "stage": self.stage,
                "progress": round(self.progress, 4), "error": self.error, "result": self.result,
                "elapsed": round(time.time() - self.started, 1)}


def run_ffmpeg(args, job, cwd=None, duration=None, on_progress=None):
    cmd = [CONFIG["ffmpeg"], "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
           "-progress", "pipe:1", "-nostats", *args]
    proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    job.proc = proc
    errors = []
    reader = threading.Thread(target=lambda: errors.extend(proc.stderr.readlines()), daemon=True)
    reader.start()
    for line in proc.stdout:
        if job.cancelled():
            proc.kill()
            break
        if duration and on_progress and line.startswith("out_time_us="):
            try:
                on_progress(min(1.0, int(line.split("=")[1]) / 1e6 / duration))
            except ValueError:
                pass
    proc.wait()
    reader.join(timeout=5)
    job.proc = None
    if job.cancelled():
        raise Cancelled()
    if proc.returncode != 0:
        detail = "".join(errors[-12:]).strip() or f"exit code {proc.returncode}"
        raise RenderError(f"FFmpeg failed: {detail}")


_probe_cache = {}


def image_size(path):
    st = Path(path).stat()
    key = (str(path), st.st_mtime, st.st_size)
    if key not in _probe_cache:
        out = subprocess.run([CONFIG["ffprobe"], "-v", "error", "-select_streams", "v:0",
                              "-show_entries", "stream=width,height", "-of", "json", str(path)],
                             capture_output=True, text=True, creationflags=NO_WINDOW)
        try:
            stream = json.loads(out.stdout)["streams"][0]
            _probe_cache[key] = (int(stream["width"]), int(stream["height"]))
        except (ValueError, KeyError, IndexError):
            raise RenderError(f"Could not read image: {Path(path).name}. Is it a valid PNG/JPG/WebP?")
    return _probe_cache[key]


# ---- narration + timeline --------------------------------------------------------------------
def validate(project):
    problems = []
    scenes = project.get("scenes") or []
    if not scenes:
        problems.append("Add at least one scene.")
    for i, scene in enumerate(scenes, 1):
        image = scene.get("image")
        if not image:
            problems.append(f"Scene {i} has no image.")
        elif not Path(image).exists():
            problems.append(f"Scene {i}: image not found ({Path(image).name}). Use Replace to locate it.")
        if not (scene.get("script") or "").strip():
            problems.append(f"Scene {i} has no narration script.")
    if problems:
        raise RenderError("\n".join(problems))


def scene_audio_key(script, settings):
    v, t = settings["voice"], settings["timing"]
    raw = json.dumps([v["voice"], round(float(v["speed"]), 3), float(t["sentence_pause"]), script])
    return hashlib.sha1(raw.encode()).hexdigest()[:20]


def narrate(project, narrator, job, progress_span=(0.0, 1.0)):
    """Generate (or load cached) narration for every scene. Returns per-scene dicts."""
    s = merged_settings(project)
    voice, speed = s["voice"]["voice"], float(s["voice"]["speed"])
    scenes = project["scenes"]
    out = []
    a, b = progress_span
    for i, scene in enumerate(scenes):
        job.update(f"Narration: scene {i + 1} of {len(scenes)}", a + (b - a) * i / len(scenes))
        audio, captions, fresh = narrator.scene(
            scene["script"], voice, speed, float(s["timing"]["sentence_pause"]),
            int(s["subtitles"]["words_per_caption"]), cancelled=job.cancelled)
        if not len(audio):
            raise RenderError(f"Scene {i + 1}: narration produced no audio. Check the script text.")
        key = scene_audio_key(scene["script"], s)
        wav = AUDIO_DIR / f"{key}.wav"
        if not wav.exists():
            sf.write(str(wav), audio, SAMPLE_RATE)
        out.append({"id": scene.get("id"), "audio": audio, "captions": captions,
                    "speech": len(audio) / SAMPLE_RATE, "audio_url": f"/api/audio/{key}.wav"})
    return out


def build_timeline(project, narration):
    """Frame-exact scene durations, the full narration track and global caption events."""
    s = merged_settings(project)
    fps = int(s["export"]["fps"])
    t = s["timing"]
    trans = s["transition"]
    d_frames = 0 if trans["type"] == "cut" else max(1, round(float(trans["duration"]) * fps))
    lead_in = max(0.0, float(t["lead_in"]))
    n = len(narration)
    scenes, frame = [], 0
    for i, item in enumerate(narration):
        last = i == n - 1
        if last:
            tail = max(0.2, float(t["end_hold"]))
        else:
            tail = max(0.0, float(t["scene_pause"]))
            if d_frames:
                tail = max(tail, d_frames / fps + 0.15)   # the whole transition fits in the pause
        frames = math.ceil((lead_in + item["speech"] + tail) * fps - 1e-6)
        scenes.append({**item, "start_frame": frame, "frames": frames,
                       "start": frame / fps, "duration": frames / fps})
        frame += frames
    total_frames = frame
    total = total_frames / fps

    track = np.zeros(int(round(total * SAMPLE_RATE)) + 1, dtype=np.float32)
    events = []
    for i, sc in enumerate(scenes):
        at = int(round((sc["start"] + lead_in) * SAMPLE_RATE))
        track[at:at + len(sc["audio"])] = sc["audio"][:len(track) - at]
        visual_end = (scenes[i + 1]["start"] - d_frames / fps) if i < n - 1 else total
        for c in sc["captions"]:
            events.append({"scene": i, "start": sc["start"] + lead_in + c["start"],
                           "end": sc["start"] + lead_in + c["end"], "text": c["text"],
                           "limit": visual_end})
    # Hold each caption until the next one when the gap is short; otherwise linger briefly.
    for j, ev in enumerate(events):
        nxt = events[j + 1] if j + 1 < len(events) else None
        if nxt and nxt["scene"] == ev["scene"] and nxt["start"] - ev["end"] < 0.6:
            ev["end"] = nxt["start"]
        else:
            ev["end"] = min(ev["end"] + 0.3, ev["limit"], nxt["start"] if nxt else total)
        ev["end"] = max(ev["end"], ev["start"] + 0.2)
    return {"fps": fps, "scenes": scenes, "total": total, "total_frames": total_frames,
            "track": track, "events": events, "d_frames": d_frames}


# ---- per-scene motion clips ------------------------------------------------------------------
def resolve_motions(project):
    s = merged_settings(project)
    result, previous = [], None
    for i, scene in enumerate(project["scenes"]):
        motion = scene.get("motion") or "default"
        if motion == "default":
            motion = s["motion"]["default"]
        random_pick = motion == "random"
        if random_pick:
            rng = random.Random(f"{scene.get('id')}-{i}")
            options = [m for m in ("zoom_in", "zoom_out", "pan_left", "pan_right") if m != previous]
            motion = rng.choice(options)
        result.append((motion, random_pick))
        previous = motion
    return result


def _fit_mode(fit):
    # Older projects saved "auto"/"blur"; those now use contain so artwork is never cropped.
    return "cover" if fit == "cover" else "contain"


def _contain_box(size, cw, ch, scale=1.0):
    """Position (x, y, w, h) of the whole image fitted inside a cw x ch canvas, centered."""
    iw, ih = size
    f = min(cw * scale / iw, ch * scale / ih)
    bw, bh = max(2, int(iw * f) // 2 * 2), max(2, int(ih * f) // 2 * 2)
    return (cw - bw) // 2, (ch - bh) // 2, bw, bh


def segment_filter(motion, frames, width, height, fps, fit, intensity, size=None, allow_zoom_fallback=False):
    """Returns (filter_graph, effective_motion)."""
    cw, ch = width * CANVAS_SCALE, height * CANVAS_SCALE
    r = INTENSITY.get(intensity, INTENSITY["subtle"])
    p = f"(on/{max(frames - 1, 1)})"
    cx, cy = "(iw-iw/zoom)/2", "(ih-ih/zoom)/2"
    if fit == "contain":
        # The picture sits at a FIXED place on the black background (edges never move); the camera
        # moves inside the picture. During a move a thin band at its edges is briefly out of view
        # (zoom: up to r, pan: r + 1%); zoom-in starts and zoom-out ends on the whole picture.
        bx, by, bw, bh = _contain_box(size, width, height)
        sw, sh = bw * CANVAS_SCALE, bh * CANVAS_SCALE          # draw the moves on a 3x copy: sub-pixel smooth
        if motion == "zoom_in":
            z, x, y = f"1+{r}*{p}", cx, cy
        elif motion == "zoom_out":
            z, x, y = f"{1 + r}-{r}*{p}", cx, cy
        elif motion == "pan_left":
            z, x, y = f"{1 + r + 0.01}", f"(iw-iw/zoom)*(1-{p})", cy
        elif motion == "pan_right":
            z, x, y = f"{1 + r + 0.01}", f"(iw-iw/zoom)*{p}", cy
        else:
            motion, z, x, y = "static", "1", "0", "0"
        return (f"[0:v]scale={sw}:{sh}:flags=lanczos,setsar=1,format=rgb24[c];"
                f"[c]zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={bw}x{bh}:fps={fps},"
                f"pad={width}:{height}:{bx}:{by}:color=black,scale=out_range=tv,format=yuv420p[v]"), motion
    canvas = (f"[0:v]scale={cw}:{ch}:force_original_aspect_ratio=increase:flags=lanczos,"
              f"crop={cw}:{ch},setsar=1[c]")
    if motion == "zoom_in":
        z, x, y = f"1+{r}*{p}", cx, cy
    elif motion == "zoom_out":
        z, x, y = f"{1 + r}-{r}*{p}", cx, cy
    elif motion == "pan_left":
        z, x, y = f"{1 + r + 0.03}", f"(iw-iw/zoom)*(1-{p})", cy
    elif motion == "pan_right":
        z, x, y = f"{1 + r + 0.03}", f"(iw-iw/zoom)*{p}", cy
    else:
        z, x, y = "1", "0", "0"
    return (f"{canvas};[c]zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={width}x{height}:fps={fps},"
            f"scale=out_range=tv,format=yuv420p[v]"), motion


def render_segment(image, motion, frames, width, height, fps, fit, intensity, preview, job,
                   allow_zoom_fallback=False):
    """Render (or reuse) one scene clip. Returns (path, movement actually used)."""
    st = Path(image).stat()
    fit = _fit_mode(fit)
    graph, used = segment_filter(motion, frames, width, height, fps, fit, intensity,
                                 image_size(image), allow_zoom_fallback)
    key = hashlib.sha1(json.dumps([SEGMENT_VERSION, str(image), st.st_mtime, st.st_size, graph,
                                   frames, preview]).encode())
    out = SEGMENT_DIR / f"{key.hexdigest()[:24]}.mp4"
    if out.exists():
        out.touch()
        return out, used
    # Intermediate clips: re-encoded once more in the final pass, so CRF 15 is visually lossless.
    preset, crf = ("veryfast", 23) if preview else ("veryfast", 15)
    tmp = out.with_name(out.stem + ".part.mp4")
    try:
        run_ffmpeg(["-i", str(image), "-filter_complex", graph,
                    "-map", "[v]", "-frames:v", str(frames), "-an", "-c:v", "libx264",
                    "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p", str(tmp)], job)
        tmp.replace(out)
    finally:
        tmp.unlink(missing_ok=True)
    return out, used


# ---- full render -----------------------------------------------------------------------------
def render(project, narrator, job, preview):
    """Render the project. Preview = half resolution, fast encode, same timeline."""
    if not CONFIG.get("ffmpeg"):
        raise RenderError("FFmpeg was not found. Install it or set 'ffmpeg' in config.json.")
    validate(project)
    s = merged_settings(project)
    narration = narrate(project, narrator, job, (0.0, 0.25))
    tl = build_timeline(project, narration)
    fps = tl["fps"]
    width, height = parse_resolution(s["export"]["resolution"])
    if preview:
        width, height = width // 2, height // 2
        width, height = width - width % 2, height - height % 2
    motions = resolve_motions(project)
    work = JOBS_DIR / job.id
    work.mkdir(parents=True, exist_ok=True)
    final_tmp = None
    try:
        sf.write(str(work / "narration.wav"), tl["track"], SAMPLE_RATE)
        subs, wm = s["subtitles"], s["watermark"]
        title = s["title"]
        burn = subs["enabled"] or (wm["enabled"] and wm["text"].strip()) or title_has_text(title)
        if burn:
            write_ass(work / "subs.ass", tl["events"] if subs["enabled"] else [], subs, width, height,
                      watermark=wm, duration=tl["total"], title=title)

        d = tl["d_frames"]
        clips, used, n = [], [], len(tl["scenes"])
        for i, sc in enumerate(tl["scenes"]):
            if job.cancelled():
                raise Cancelled()
            motion, random_pick = motions[i]
            job.update(f"Rendering scene {i + 1} of {n} ({motion.replace('_', ' ')})",
                       0.25 + 0.35 * i / n)
            frames = sc["frames"] + (d if i > 0 else 0)
            clip, actual = render_segment(project["scenes"][i]["image"], motion, frames, width,
                                          height, fps, s["motion"]["fit"], s["motion"]["intensity"],
                                          preview, job, allow_zoom_fallback=random_pick)
            clips.append(clip)
            used.append(actual)

        args = []
        for clip in clips:
            args += ["-i", str(clip)]
        args += ["-i", "narration.wav"]
        parts = [f"[{i}:v]settb=AVTB,setpts=PTS-STARTPTS[v{i}]" for i in range(n)]
        if n == 1:
            last = "v0"
        elif d == 0:
            parts.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[vc]")
            last = "vc"
        else:
            kind = "fadeblack" if s["transition"]["type"] == "fadeblack" else "fade"
            last = "v0"
            for i in range(1, n):
                offset = (tl["scenes"][i]["start_frame"] - d) / fps
                parts.append(f"[{last}][v{i}]xfade=transition={kind}:duration={d / fps:.6f}:"
                             f"offset={offset:.6f}[x{i}]")
                last = f"x{i}"
        sub_filter = "ass=subs.ass," if burn else ""
        parts.append(f"[{last}]{sub_filter}scale=out_range=tv,format=yuv420p[out]")  # JPGs are full-range; output standard TV range
        if preview:
            preset, crf = "ultrafast", 26
        else:
            preset, crf = QUALITY.get(s["export"]["quality"], QUALITY["high"])
        enc = ["-filter_complex", ";".join(parts), "-map", "[out]", "-map", f"{n}:a",
               "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high",
               "-pix_fmt", "yuv420p", "-color_range", "tv", "-r", str(fps), "-c:a", "aac", "-b:a", "192k",
               "-ar", "48000", "-ac", "2", "-t", f"{tl['total']:.6f}", "-movflags", "+faststart"]

        if preview:
            for old in PREVIEW_DIR.glob("preview_*.mp4"):
                old.unlink(missing_ok=True)
            final = PREVIEW_DIR / f"preview_{job.id}.mp4"
        else:
            out_dir = Path(s["export"]["output_dir"] or EXPORTS_DIR)
            out_dir.mkdir(parents=True, exist_ok=True)
            base = _safe_name(s["export"]["filename"] or project.get("name") or "StoryCraft")
            final = out_dir / f"{base}.mp4"
            k = 2
            while final.exists():
                final = out_dir / f"{base} ({k}).mp4"
                k += 1
        final_tmp = final.with_name(final.stem + ".partial.mp4")
        job.update("Assembling video, transitions and subtitles", 0.6)
        run_ffmpeg(args + enc + [str(final_tmp)], job, cwd=str(work), duration=tl["total"],
                   on_progress=lambda f: job.update(f"Assembling video: {int(f * 100)}%",
                                                    0.6 + 0.4 * f))
        final_tmp.replace(final)
        final_tmp = None
        return {"path": str(final), "duration": round(tl["total"], 3), "width": width,
                "height": height, "scenes": scene_summary(tl), "motions": used}
    finally:
        if final_tmp is not None:
            Path(final_tmp).unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)


RESOLUTIONS = {"1080x1920", "720x1280", "1920x1080", "1280x720"}


def parse_resolution(value):
    """'1920x1080' -> (1920, 1080). Unknown values fall back to vertical 1080x1920."""
    value = value if value in RESOLUTIONS else "1080x1920"
    w, h = value.split("x")
    return int(w), int(h)


def scene_summary(tl):
    return [{"id": sc["id"], "duration": round(sc["duration"], 3), "speech": round(sc["speech"], 3),
             "start": round(sc["start"], 3), "audio_url": sc["audio_url"],
             "captions": [{"start": round(c["start"], 3), "end": round(c["end"], 3), "text": c["text"]}
                          for c in sc["captions"]]} for sc in tl["scenes"]]


def _safe_name(name):
    cleaned = "".join(ch for ch in name if ch not in '<>:"/\\|?*').strip().rstrip(".")
    return cleaned or "StoryCraft"


SEGMENT_CACHE_MB = 300
SEGMENT_MAX_AGE_DAYS = 7


def trim_segments(max_mb=SEGMENT_CACHE_MB, max_age_days=SEGMENT_MAX_AGE_DAYS):
    """Keep the clip cache small: drop clips older than a week, then the least recently used ones
    until the cache is under max_mb. Clips used in the last 10 minutes (the current render) stay."""
    now = time.time()
    files = []
    for f in SEGMENT_DIR.glob("*.mp4"):
        try:
            st = f.stat()
        except OSError:
            continue
        if f.name.endswith(".part.mp4") or st.st_mtime < now - max_age_days * 86400:
            f.unlink(missing_ok=True)
        else:
            files.append((st.st_mtime, st.st_size, f))
    total = sum(size for _, size, _ in files)
    for mtime, size, f in sorted(files):            # oldest use first
        if total <= max_mb * 1024 * 1024 or mtime > now - 600:
            break
        f.unlink(missing_ok=True)
        total -= size


def _dir_size(d, pattern="*"):
    return sum(f.stat().st_size for f in d.glob(pattern) if f.is_file())


def cache_info():
    return {"clips_mb": round(_dir_size(SEGMENT_DIR) / 1048576, 1),
            "previews_mb": round(_dir_size(PREVIEW_DIR) / 1048576, 1),
            "narration_mb": round((_dir_size(AUDIO_DIR) + _dir_size(WORKSPACE / "cache" / "tts")) / 1048576, 1)}


def clear_video_cache():
    """Delete cached clips and old previews (rebuilt automatically). Narration cache is kept."""
    for f in list(SEGMENT_DIR.glob("*.mp4")) + list(PREVIEW_DIR.glob("*.mp4")):
        f.unlink(missing_ok=True)


def cleanup_cache():
    """At startup: trim the clip cache and remove temp folders left by an interrupted render."""
    trim_segments()
    for d in JOBS_DIR.iterdir():
        shutil.rmtree(d, ignore_errors=True)
