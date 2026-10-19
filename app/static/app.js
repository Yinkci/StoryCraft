"use strict";
/* StoryCraft — browser UI. All heavy lifting (Kokoro, FFmpeg) happens in the local Python server. */

const $ = (sel, el = document) => el.querySelector(sel);
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).slice(0, 12);
const imgUrl = (path) => `/api/image?path=${encodeURIComponent(path)}`;
const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(1)} s`);
const naturalSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

const MOTION_LABELS = {
  static: "Static", zoom_in: "Slow zoom in", zoom_out: "Slow zoom out",
  pan_left: "Slow pan left", pan_right: "Slow pan right", random: "Random subtle",
};

async function api(url, body) {
  const opts = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  };
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch { /* keep */ }
    throw new Error(msg);
  }
  return res.json();
}

async function uploadFiles(files) {
  const list = [...files].filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name)).sort(naturalSort);
  if (!list.length) throw new Error("Please choose PNG, JPG or WebP images.");
  const fd = new FormData();
  list.forEach((f) => fd.append("files", f));
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Upload failed");
  return res.json();
}

/* ---------------------------------------------------------------- state */
let STATUS = null;
const state = {
  project: null,
  path: null,
  dirty: false,
  narration: {},          // narration signature -> {speech, audio_url, captions}
  preview: { url: null, sig: null },
  job: null,
  jobSnapshot: null,
  missing: new Set(),
};

function newProject() {
  return { name: "New episode", scenes: [], settings: clone(STATUS.defaults) };
}
const S = () => state.project.settings;

function narrationSig(scene, settings = S()) {
  return JSON.stringify([(scene.script || "").trim(), settings.voice.voice, +settings.voice.speed,
    +settings.timing.sentence_pause]);
}
function renderSig(project) {
  const p = clone(project);
  delete p.name;
  delete p.settings.export.output_dir;
  delete p.settings.export.filename;
  delete p.settings.export.quality;
  return JSON.stringify(p);
}

/* Same formula as the server: lead-in + speech + pause, rounded up to whole frames. */
function sceneDuration(index) {
  const s = S(), scenes = state.project.scenes, sc = scenes[index];
  const n = state.narration[narrationSig(sc)];
  if (!n) return null;
  const fps = +s.export.fps, last = index === scenes.length - 1;
  const d = s.transition.type === "cut" ? 0 : Math.max(1, Math.round(+s.transition.duration * fps)) / fps;
  let tail = last ? Math.max(0.2, +s.timing.end_hold) : Math.max(0, +s.timing.scene_pause);
  if (!last && d) tail = Math.max(tail, d + 0.15);
  return Math.ceil((+s.timing.lead_in + n.speech + tail) * fps - 1e-6) / fps;
}

function markDirty() {
  state.dirty = true;
  $("#dirtyMark").hidden = false;
  scheduleAutosave();
  updatePreviewStale();
}
function markClean() {
  state.dirty = false;
  $("#dirtyMark").hidden = true;
  scheduleAutosave();
}

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem("storycraft.autosave", JSON.stringify({
        project: state.project, path: state.path, dirty: state.dirty, narration: state.narration,
      }));
    } catch { /* storage unavailable — autosave is only a convenience */ }
  }, 400);
}

/* ---------------------------------------------------------------- scenes UI */
const list = $("#sceneList");

function renderScenes() {
  list.innerHTML = "";
  const scenes = state.project.scenes;
  if (!scenes.length) {
    list.innerHTML = `<div class="empty-state"><h3>Start your episode</h3>
      Drop your numbered scene images below, or use <b>Bulk import</b> to add images and paste all scripts at once.</div>`;
  }
  scenes.forEach((sc, i) => list.appendChild(sceneElement(sc, i)));
  updateTotals();
  updatePoster();
}

function sceneElement(sc, i) {
  const el = $("#sceneTpl").content.firstElementChild.cloneNode(true);
  el.dataset.id = sc.id;
  $(".num", el).textContent = i + 1;
  const thumb = $(".thumb", el), img = $("img", thumb);
  if (!sc.image) thumb.classList.add("empty");
  else if (state.missing.has(sc.image)) thumb.classList.add("missing");
  else {
    img.src = imgUrl(sc.image);
    img.onerror = () => { state.missing.add(sc.image); thumb.classList.add("missing"); updateBanner(); };
  }
  $(".filename", el).textContent = sc.image_name || (sc.image ? sc.image.split(/[\\/]/).pop() : "No image yet");
  const ta = $(".script", el);
  ta.value = sc.script || "";
  ta.addEventListener("input", () => {
    sc.script = ta.value;
    markDirty();
    updateSceneInfo(el, sc, i);
    updateTotals();
    if (i === 0) updatePoster();
  });

  const motion = $(".motion", el);
  const def = MOTION_LABELS[S().motion.default] || S().motion.default;
  motion.innerHTML = `<option value="default">Default (${def})</option>` +
    STATUS.motions.map((m) => `<option value="${m}">${MOTION_LABELS[m] || m}</option>`).join("");
  motion.value = sc.motion || "default";
  motion.addEventListener("change", () => { sc.motion = motion.value; markDirty(); });

  thumb.addEventListener("click", () => pickReplacement(sc.id));
  $(".act-replace", el).addEventListener("click", () => pickReplacement(sc.id));
  $(".act-dup", el).addEventListener("click", () => {
    state.project.scenes.splice(i + 1, 0, { ...clone(sc), id: uid() });
    markDirty(); renderScenes();
  });
  $(".act-del", el).addEventListener("click", async () => {
    if ((sc.script || "").trim() && !(await confirmBox("Delete scene?", `Scene ${i + 1} and its script will be removed.`, "Delete scene"))) return;
    const [removed] = state.project.scenes.splice(i, 1);
    markDirty(); renderScenes();
    toast(`Scene ${i + 1} deleted.`, "Undo", () => {
      state.project.scenes.splice(Math.min(i, state.project.scenes.length), 0, removed);
      markDirty(); renderScenes();
    }, 8000);
  });
  $(".act-up", el).addEventListener("click", () => moveScene(i, i - 1));
  $(".act-down", el).addEventListener("click", () => moveScene(i, i + 1));
  $(".act-play", el).addEventListener("click", (e) => playScene(i, e.currentTarget));

  // drag to reorder (only from the handle) + drop an image file to replace
  const handle = $(".handle", el);
  handle.addEventListener("mousedown", () => { el.draggable = true; });
  el.addEventListener("dragstart", (e) => {
    if (!el.draggable) return;
    e.dataTransfer.setData("text/x-scene", String(i));
    e.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => { el.draggable = false; el.classList.remove("dragging"); clearDropMarks(); });
  el.addEventListener("dragover", (e) => {
    const types = e.dataTransfer.types;
    if (types.includes("text/x-scene")) {
      e.preventDefault();
      clearDropMarks();
      const r = el.getBoundingClientRect();
      el.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
    } else if (types.includes("Files")) {
      e.preventDefault(); e.stopPropagation();
      el.classList.add("file-over");
    }
  });
  el.addEventListener("dragleave", () => el.classList.remove("file-over", "drop-before", "drop-after"));
  el.addEventListener("drop", async (e) => {
    const from = e.dataTransfer.getData("text/x-scene");
    e.preventDefault(); e.stopPropagation();
    if (from !== "") {
      const before = el.classList.contains("drop-before");
      clearDropMarks();
      moveScene(+from, before ? i : i + 1, true);
    } else if (e.dataTransfer.files.length) {
      el.classList.remove("file-over");
      await replaceImage(sc.id, e.dataTransfer.files[0]);
    }
  });
  updateSceneInfo(el, sc, i);
  return el;
}

function clearDropMarks() {
  list.querySelectorAll(".drop-before, .drop-after, .file-over").forEach((n) => n.classList.remove("drop-before", "drop-after", "file-over"));
}

function moveScene(from, to, insertMode = false) {
  const scenes = state.project.scenes;
  if (insertMode) { if (to > from) to -= 1; }
  if (to < 0 || to >= scenes.length || to === from) return;
  const [sc] = scenes.splice(from, 1);
  scenes.splice(to, 0, sc);
  markDirty(); renderScenes();
}

function updateSceneInfo(el, sc, i) {
  const text = (sc.script || "").trim();
  const words = text ? text.split(/\s+/).length : 0;
  const sentences = text ? (text.match(/[.!?…]+(\s|$)/g) || []).length || 1 : 0;
  $(".stats", el).textContent = words ? `${sentences} sentence${sentences === 1 ? "" : "s"} · ${words} words` : "No script yet";
  const chip = $(".duration", el), d = sceneDuration(i);
  chip.classList.toggle("ready", d !== null);
  chip.classList.toggle("stale", d === null);
  chip.textContent = d !== null ? `⏱ ${fmtSec(d)}` : (text ? "⏱ not generated" : "⏱ —");
}

function updateTotals() {
  const scenes = state.project.scenes;
  $("#sceneCount").textContent = scenes.length ? `(${scenes.length})` : "";
  list.querySelectorAll(".scene").forEach((el, i) => updateSceneInfo(el, scenes[i], i));
  const ds = scenes.map((_, i) => sceneDuration(i));
  $("#totalDuration").textContent = scenes.length && ds.every((d) => d !== null)
    ? `Total ${fmtSec(ds.reduce((a, b) => a + b, 0))}` : "";
}

async function addImagesAsScenes(files) {
  try {
    const uploaded = await uploadFiles(files);
    uploaded.forEach((u) => state.project.scenes.push({ id: uid(), image: u.path, image_name: u.name, script: "", motion: "default" }));
    markDirty(); renderScenes();
    toast(`Added ${uploaded.length} scene${uploaded.length === 1 ? "" : "s"}. Next: click Import full script to paste your narration.`);
  } catch (e) { showMessage("Could not add images", e.message); }
}

let replaceTarget = null;
function pickReplacement(id) { replaceTarget = id; $("#replaceInput").value = ""; $("#replaceInput").click(); }
$("#replaceInput").addEventListener("change", (e) => { if (e.target.files[0]) replaceImage(replaceTarget, e.target.files[0]); });

async function replaceImage(id, file) {
  try {
    const [u] = await uploadFiles([file]);
    const sc = state.project.scenes.find((s) => s.id === id);
    if (!sc) return;
    state.missing.delete(sc.image);
    sc.image = u.path; sc.image_name = u.name;
    markDirty(); renderScenes(); updateBanner();
  } catch (e) { showMessage("Could not replace image", e.message); }
}

/* per-scene narration preview */
const player = $("#player");
async function playScene(i, btn) {
  const sc = state.project.scenes[i];
  if (!(sc.script || "").trim()) { toast("Write the narration for this scene first."); return; }
  btn.classList.add("busy"); btn.disabled = true;
  try {
    const r = await api("/api/scene_audio", { project: state.project, index: i });
    state.narration[narrationSig(sc)] = { speech: r.speech, audio_url: r.audio_url, captions: r.captions };
    updateTotals(); scheduleAutosave();
    player.src = r.audio_url; player.play();
  } catch (e) { showMessage("Narration failed", e.message); }
  finally { btn.classList.remove("busy"); btn.disabled = false; }
}

/* ---------------------------------------------------------------- settings UI */
const sec = (v) => `${(+v).toFixed(2)} s`;
const BIND = [
  ["sVoice", "voice", "voice"], ["sSpeed", "voice", "speed", "num", "oSpeed", (v) => `${(+v).toFixed(2)}×`],
  ["sSubEnabled", "subtitles", "enabled", "bool"], ["sFont", "subtitles", "font"],
  ["sSize", "subtitles", "size", "num"], ["sPosX", "subtitles", "position_x", "num"],
  ["sMaxW", "subtitles", "max_width", "num"],
  ["sWords", "subtitles", "words_per_caption", "num", "oWords", (v) => `~${v}`],
  ["sOutline", "subtitles", "outline", "num", "oOutline", (v) => v],
  ["sShadow", "subtitles", "shadow", "num", "oShadow", (v) => v],
  ["sPos", "subtitles", "position", "num"],
  ["sColor", "subtitles", "color"], ["sOutlineColor", "subtitles", "outline_color"],
  ["sBold", "subtitles", "bold", "bool"], ["sUpper", "subtitles", "uppercase", "bool"],
  ["tEnabled", "title", "enabled", "bool"], ["tFont", "title", "font"], ["tColor", "title", "color"],
  ["tHighlight", "title", "highlight"], ["tOutlineColor", "title", "outline_color"],
  ["tUpper", "title", "uppercase", "bool"], ["tBold", "title", "bold", "bool"],
  ["tOutline", "title", "outline", "num", "oTOutline", (v) => v], ["tShadow", "title", "shadow", "num", "oTShadow", (v) => v],
  ["tPosX", "title", "position_x", "num"], ["tPosY", "title", "position_y", "num"], ["tDuration", "title", "duration", "num"],
  ["wEnabled", "watermark", "enabled", "bool"], ["wText", "watermark", "text"], ["wFont", "watermark", "font"],
  ["wPosX", "watermark", "position_x", "num"], ["wPosY", "watermark", "position_y", "num"],
  ["wSize", "watermark", "size", "num"], ["wOpacity", "watermark", "opacity", "num"],
  ["wOutline", "watermark", "outline", "num", "oWOutline", (v) => v], ["wShadow", "watermark", "shadow", "num", "oWShadow", (v) => v],
  ["wColor", "watermark", "color"], ["wOutlineColor", "watermark", "outline_color"], ["wBold", "watermark", "bold", "bool"],
  ["sMotion", "motion", "default"], ["sIntensity", "motion", "intensity"], ["sFit", "motion", "fit"],
  ["sTransition", "transition", "type"], ["sTransDur", "transition", "duration", "num", "oTransDur", sec],
  ["sPause", "timing", "scene_pause", "num", "oPause", sec], ["sSentPause", "timing", "sentence_pause", "num", "oSentPause", sec],
  ["sLead", "timing", "lead_in", "num", "oLead", sec], ["sEnd", "timing", "end_hold", "num", "oEnd", sec],
  ["sOutDir", "export", "output_dir"], ["sFilename", "export", "filename"],
  ["sFps", "export", "fps", "num"], ["sQuality", "export", "quality"],
];

function settingsToUI() {
  for (const [id, section, key, type, out, fmt] of BIND) {
    const el = $("#" + id), v = S()[section][key];
    if (type === "bool") el.checked = !!v; else el.value = v;
    if (out) $("#" + out).textContent = fmt ? fmt(v) : v;
    syncNumber(id, v);
  }
  $("#sTransDur").disabled = S().transition.type === "cut";
  renderTitleLines();
  updateFormatUI();
  $("#projectName").value = state.project.name || "";
}

function bindSettings() {
  for (const [id, section, key, type, out, fmt] of BIND) {
    const el = $("#" + id);
    const handler = () => {
      let v = type === "bool" ? el.checked : el.value;
      if (type === "num") v = +v;
      S()[section][key] = v;
      if (out) $("#" + out).textContent = fmt ? fmt(v) : v;
      syncNumber(id, v);
      if (POSITION_IDS.includes(id) && state.preview.url) setPositioning(true);
      if (id === "sTransition") $("#sTransDur").disabled = v === "cut";
      if (id === "sMotion") renderScenes(); else updateTotals();
      updatePoster();
      markDirty();
    };
    el.addEventListener(el.tagName === "SELECT" || type === "bool" ? "change" : "input", handler);
  }
  $("#projectName").addEventListener("input", (e) => { state.project.name = e.target.value; markDirty(); });
}

function fillStaticOptions() {
  const byLang = {};
  STATUS.voices.forEach((v) => (byLang[v.language] ||= []).push(v));
  $("#sVoice").innerHTML = Object.entries(byLang).map(([lang, vs]) =>
    `<optgroup label="${lang}">${vs.map((v) => `<option value="${v.id}">${v.label.split(" — ")[0]} (${v.id})</option>`).join("")}</optgroup>`).join("");
  $("#sMotion").innerHTML = STATUS.motions.map((m) => `<option value="${m}">${MOTION_LABELS[m] || m}</option>`).join("");
  $("#fontList").innerHTML = STATUS.fonts.map((f) => `<option value="${f.replace(/"/g, "&quot;")}">`).join("");
}

// Quick subtitle switch under the preview; drives the same setting as "Burn subtitles into video".
$("#btnSubToggle").addEventListener("click", () => {
  const box = $("#sSubEnabled");
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change"));
  toast(box.checked ? "Subtitles on — they'll be burned into the video." : "Subtitles off — the video will have no captions.");
});

$("#btnTestVoice").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.classList.add("busy"); btn.disabled = true;
  try {
    const first = state.project.scenes.find((s) => (s.script || "").trim());
    const r = await api("/api/test_voice", { voice: S().voice.voice, speed: S().voice.speed, text: first ? first.script : "" });
    player.src = r.audio_url; player.play();
  } catch (err) { showMessage("Voice test failed", err.message); }
  finally { btn.classList.remove("busy"); btn.disabled = false; }
});

$("#btnBrowse").addEventListener("click", async () => {
  const r = await api("/api/dialog/folder", { initial: S().export.output_dir });
  if (r.path) { S().export.output_dir = r.path; $("#sOutDir").value = r.path; markDirty(); }
});

/* ---------------------------------------------------------------- video format (9:16 / 16:9) */
// Subtitle size/position/width that suit each format; swapped only if the user hasn't customised them.
const SUB_LAYOUT = { landscape: { size: 64, position: 8, max_width: 70, outline: 4.5, shadow: 1.5 } };
function subLayout(format) {
  if (format === "landscape") return SUB_LAYOUT.landscape;
  const d = STATUS.defaults.subtitles;
  return { size: d.size, position: d.position, max_width: d.max_width, outline: d.outline, shadow: d.shadow };
}
function currentFormat() {
  const [w, h] = String(S().export.resolution).split("x").map(Number);
  return { format: w > h ? "landscape" : "vertical", p: Math.min(w, h) || 1080 };
}
function setFormat(format, p) {
  const cur = currentFormat();
  p = p || cur.p;
  if (format === cur.format && p === cur.p) return;
  const long = p === 720 ? 1280 : 1920;
  S().export.resolution = format === "landscape" ? `${long}x${p}` : `${p}x${long}`;
  if (format !== cur.format) {
    const s = S().subtitles, old = subLayout(cur.format);
    if (Object.keys(old).every((k) => +s[k] === +old[k])) {
      setSubtitleValues(subLayout(format));
    } else {
      toast("Format changed. You customised the subtitles, so check their size and position in the preview.");
    }
    resnapWatermark(cur.format, format);
  }
  updateFormatUI();
  updatePoster();
  markDirty();
}
function updateFormatUI() {
  const { format, p } = currentFormat();
  document.body.classList.toggle("landscape", format === "landscape");
  document.querySelectorAll(".format-switch button").forEach((b) => {
    b.classList.toggle("active", b.dataset.format === format);
    b.setAttribute("aria-checked", String(b.dataset.format === format));
  });
  $("#sFormat").value = format;
  $("#sResP").value = String(p);
  const [w, h] = S().export.resolution.split("x");
  $("#exportHint").textContent = `${w} × ${h} MP4 · H.264 · AAC · yuv420p — ready for ${format === "landscape" ? "regular YouTube videos" : "YouTube Shorts and Facebook Reels"}.`;
}
document.querySelectorAll(".format-switch button").forEach((b) => b.addEventListener("click", () => setFormat(b.dataset.format)));
$("#sFormat").addEventListener("change", (e) => setFormat(e.target.value));
$("#sResP").addEventListener("change", (e) => setFormat(currentFormat().format, +e.target.value));

/* ---------------------------------------------------------------- title text (top overlay) */
const TITLE_HIGHLIGHT = /\*([^*]+)\*/g;

function setTitle(values) {
  Object.assign(S().title, values);
  for (const [id, section, key, , out, fmt] of BIND) {
    if (section !== "title" || !(key in values)) continue;
    const el = $("#" + id);
    if (el.type === "checkbox") el.checked = !!values[key]; else el.value = values[key];
    syncNumber(id, values[key]);
    if (out) $("#" + out).textContent = fmt ? fmt(values[key]) : values[key];
  }
  updatePoster();
  markDirty();
}

function titleChanged() {
  const t = S().title;
  if (!t.enabled && t.lines.some((l) => (l.text || "").trim())) setTitle({ enabled: true });   // typing turns it on
  if (state.preview.url) setPositioning(true);
  updatePoster();
  markDirty();
}

function renderTitleLines() {
  const box = $("#titleLines"), t = S().title;
  if (!Array.isArray(t.lines) || !t.lines.length) t.lines = [{ text: "", size: 90 }];
  box.innerHTML = "";
  t.lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "title-line";
    row.innerHTML = `<input spellcheck="true" placeholder="${i === 0 ? "*ZOMBIE* OUTBREAK:" : "Next line"}">
      <input type="number" class="num" min="16" max="240" step="1" title="Size of this line (px)">
      <button class="icon-btn" title="Remove this line">✕</button>`;
    const [text, size, del] = row.children;
    text.value = line.text || "";
    size.value = line.size || 90;
    text.addEventListener("input", () => { line.text = text.value; titleChanged(); });
    size.addEventListener("input", () => { if (+size.value >= 16) { line.size = Math.min(240, +size.value); titleChanged(); } });
    del.addEventListener("click", () => {
      t.lines.splice(i, 1);
      renderTitleLines(); titleChanged();
    });
    box.appendChild(row);
  });
}
$("#btnAddTitleLine").addEventListener("click", () => {
  const lines = S().title.lines, last = lines[lines.length - 1];
  lines.push({ text: "", size: Math.max(30, Math.round((last?.size || 90) * 0.65)) });   // e.g. a smaller "PART 2"
  renderTitleLines();
  $("#titleLines").lastElementChild.querySelector("input").focus();
  markDirty();
});
$("#btnTitleCenter").addEventListener("click", () => setTitle({ position_x: 50 }));
$("#btnTitleReset").addEventListener("click", () => setTitle({ position_x: 50, position_y: 5 }));

function updateTitlePreview(scale) {
  const t = S().title, el = $("#posterTitle");
  const lines = (t.lines || []).filter((l) => (l.text || "").trim());
  el.hidden = !t.enabled || !lines.length;
  $("#titleWarn").hidden = true;
  if (el.hidden) return;
  el.innerHTML = "";
  const k = assSizeFactor(t.font, t.bold);
  for (const line of lines) {
    const row = document.createElement("div");
    const text = t.uppercase ? line.text.trim().toUpperCase() : line.text.trim();
    let pos = 0;
    for (const m of text.matchAll(TITLE_HIGHLIGHT)) {
      row.appendChild(document.createTextNode(text.slice(pos, m.index)));
      const span = document.createElement("span");
      span.style.color = t.highlight;
      span.textContent = m[1];
      row.appendChild(span);
      pos = m.index + m[0].length;
    }
    row.appendChild(document.createTextNode(text.slice(pos).replace(/\*/g, "")));
    row.style.fontSize = `calc(${line.size * scale * k}cqh)`;
    row.style.lineHeight = `calc(${line.size * scale}cqh)`;   // ASS line height = the size value
    el.appendChild(row);
  }
  el.style.left = `${t.position_x}%`;
  el.style.top = `${t.position_y}%`;
  el.style.fontFamily = `"${t.font}", Impact, sans-serif`;
  el.style.fontWeight = t.bold ? "700" : "400";
  el.style.color = t.color;
  el.style.webkitTextStroke = t.outline ? `calc(${t.outline * 2 * scale}cqh) ${t.outline_color}` : "0";
  el.style.textShadow = t.shadow ? `0 calc(${t.shadow * scale}cqh) calc(${t.shadow * scale}cqh) rgba(0,0,0,.6)` : "none";
  // Lines are never wrapped (so the layout is exactly what you typed): warn when one is too wide.
  const box = $("#previewBox").getBoundingClientRect(), r = el.getBoundingClientRect();
  if (box.width && (r.left < box.left - 1 || r.right > box.right + 1)) {
    const w = $("#titleWarn");
    w.hidden = false;
    w.textContent = "⚠ The title is wider than the video. Make a line smaller or split it into two lines.";
  }
}

/* ---------------------------------------------------------------- watermark */
const ANCHORS = { tl: [0, 0, "Top left"], tc: [.5, 0, "Top center"], tr: [1, 0, "Top right"],
  ml: [0, .5, "Middle left"], c: [.5, .5, "Center"], mr: [1, .5, "Middle right"],
  bl: [0, 1, "Bottom left"], bc: [.5, 1, "Bottom center"], br: [1, 1, "Bottom right"] };
const WM_MARGIN = 48;   // px in the 1080p frame between a corner watermark and the edge

function setWatermark(values) {
  Object.assign(S().watermark, values);
  for (const [id, section, key, , out, fmt] of BIND) {
    if (section !== "watermark" || !(key in values)) continue;
    const el = $("#" + id);
    if (el.type === "checkbox") el.checked = !!values[key]; else el.value = values[key];
    syncNumber(id, values[key]);
    if (out) $("#" + out).textContent = fmt ? fmt(values[key]) : values[key];
  }
  updatePoster();
  markDirty();
}

/* Snap to one of nine spots: the anchor point of the text sits WM_MARGIN px from the edges. */
function snappedPos(anchor, format) {
  const [fx, fy] = ANCHORS[anchor] || ANCHORS.br;
  const land = format === "landscape";
  const mx = (WM_MARGIN / (land ? 1920 : 1080)) * 100, my = (WM_MARGIN / (land ? 1080 : 1920)) * 100;
  const pos = (f, m) => +(f === 0 ? m : f === 1 ? 100 - m : 50).toFixed(1);
  return { position_x: pos(fx, mx), position_y: pos(fy, my) };
}
function snapWatermark(anchor) {
  setWatermark({ anchor, ...snappedPos(anchor, currentFormat().format), enabled: true });
}
/* On a format change, a watermark sitting on a snap spot moves to the same spot in the new format
   (same pixel margin from the edges); a hand-placed one keeps its X/Y percentages. */
function resnapWatermark(oldFormat, newFormat) {
  const w = S().watermark, was = snappedPos(w.anchor, oldFormat);
  const untouched = +w.position_x === 96 && +w.position_y === 96;
  if (!untouched && (+w.position_x !== was.position_x || +w.position_y !== was.position_y)) return;
  const pos = snappedPos(w.anchor, newFormat);
  Object.assign(w, pos);
  [["wPosX", pos.position_x], ["wPosY", pos.position_y]].forEach(([id, v]) => { $("#" + id).value = v; syncNumber(id, v); });
}
document.querySelectorAll("#wAnchorGrid button").forEach((b) => b.addEventListener("click", () => snapWatermark(b.dataset.anchor)));
$("#wText").addEventListener("input", () => {
  // Typing a watermark switches it on, so it shows up right away.
  const w = S().watermark;
  if (!$("#wText").value.trim() || w.enabled) return;
  if (+w.position_x === 96 && +w.position_y === 96) snapWatermark(w.anchor || "br");   // first use: bottom right
  else setWatermark({ enabled: true });
});

function updateWatermarkPreview(scale) {
  const w = S().watermark, el = $("#posterWatermark");
  const text = (w.text || "").trim();
  el.hidden = !w.enabled || !text;
  const anchor = ANCHORS[w.anchor] ? w.anchor : "br";
  document.querySelectorAll("#wAnchorGrid button").forEach((b) => b.classList.toggle("active", b.dataset.anchor === anchor));
  $("#wAnchorName").textContent = ANCHORS[anchor][2];
  if (el.hidden) return;
  const [fx, fy] = ANCHORS[anchor];
  el.textContent = text;
  el.style.left = `${w.position_x}%`;
  el.style.top = `${w.position_y}%`;
  el.style.transform = `translate(${-fx * 100}%, ${-fy * 100}%)`;
  el.style.fontFamily = `"${w.font}", Arial, sans-serif`;
  el.style.fontWeight = w.bold ? "700" : "400";
  el.style.fontSize = `calc(${w.size * scale * assSizeFactor(w.font, w.bold)}cqh)`;
  el.style.color = w.color;
  el.style.opacity = w.opacity / 100;
  el.style.webkitTextStroke = w.outline ? `calc(${w.outline * 2 * scale}cqh) ${w.outline_color}` : "0";
  el.style.textShadow = w.shadow ? `0 calc(${w.shadow * scale}cqh) calc(${w.shadow * scale}cqh) rgba(0,0,0,.5)` : "none";
}

/* ---------------------------------------------------------------- preview pane */
function updatePoster() {
  const s = S().subtitles, first = state.project.scenes.find((sc) => sc.image && !state.missing.has(sc.image));
  const img = $("#posterImg");
  $("#poster").classList.toggle("cover", S().motion.fit === "cover");
  if (first) img.src = imgUrl(first.image); else img.removeAttribute("src");
  const cap = $("#posterCaption");
  const script = (state.project.scenes[0]?.script || "").trim();
  const words = script ? script.split(/\s+/).slice(0, Math.max(2, +s.words_per_caption)).join(" ") : "the world was about to end.";
  cap.textContent = s.uppercase ? words.toUpperCase() : words;
  cap.hidden = !s.enabled;
  const cc = $("#btnSubToggle");
  cc.classList.toggle("on", !!s.enabled);
  cc.setAttribute("aria-checked", String(!!s.enabled));
  $("#subToggleLabel").textContent = s.enabled ? "Subtitles on" : "Subtitles off";
  // ASS sizes are in a 1080p frame (1080x1920 vertical, 1920x1080 landscape); cqh = 1% of preview height
  const scale = 100 / (currentFormat().format === "landscape" ? 1080 : 1920);
  cap.style.fontFamily = `"${s.font}", "Arial Black", sans-serif`;
  cap.style.fontWeight = s.bold ? "700" : "400";  // ASS Bold = weight 700
  cap.style.fontSize = `calc(${s.size * scale * assSizeFactor(s.font, s.bold)}cqh)`;
  cap.style.color = s.color;
  cap.style.webkitTextStroke = `calc(${s.outline * 2 * scale}cqh) ${s.outline_color}`;
  cap.style.textShadow = s.shadow ? `0 calc(${s.shadow * scale}cqh) calc(${s.shadow * scale}cqh) rgba(0,0,0,.6)` : "none";
  const num = (v, d) => (Number.isFinite(+v) && v !== "" && v !== null ? +v : d);
  // Same rule as captions.caption_margins(): near an edge the box narrows so the text stays centered at X.
  const x = Math.min(100, Math.max(0, num(s.position_x, 50)));
  const half = Math.max(12, Math.min(num(s.max_width, 84) / 2, x, 100 - x));
  const center = Math.min(Math.max(x, half), 100 - half);
  cap.style.left = `${center - half}%`;
  cap.style.width = `${2 * half}%`;
  cap.style.right = "auto";
  cap.style.bottom = `${s.position}%`;
  updateWatermarkPreview(scale);
  updateTitlePreview(scale);
}

/* ASS "Fontsize" is the font's full line height (ascent + descent), CSS font-size is the em box.
   Measure the font so the preview caption is drawn at the same size libass renders it. */
const sizeFactors = {};
function assSizeFactor(font, bold) {
  const key = `${font}|${bold}`;
  if (!(key in sizeFactors)) {
    let k = 1;
    try {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = `${bold ? 700 : 400} 100px "${font}", "Arial Black", sans-serif`;
      const m = ctx.measureText("Hg");
      const h = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
      if (h > 50 && h < 250) k = 100 / h;
    } catch { /* keep 1 */ }
    sizeFactors[key] = k;
  }
  return sizeFactors[key];
}

function updatePreviewStale() {
  const has = !!state.preview.url;
  $("#previewStale").hidden = !has || state.preview.sig === renderSig(state.project);
}

function showPreview(url) {
  const v = $("#previewVideo");
  v.src = url;
  setPositioning(false);
}

/* Subtitle position: number boxes, drag on the preview, positioning mode. */
const POSITION_IDS = ["sSize", "sPosX", "sPos", "sMaxW", "wPosX", "wPosY", "wSize", "wText", "tPosX", "tPosY"];
let positioning = false;

function syncNumber(id, v) {
  const box = document.querySelector(`.num[data-for="${id}"]`);
  if (box && document.activeElement !== box) box.value = v;
}
document.querySelectorAll(".num[data-for]").forEach((box) => {
  box.addEventListener("input", () => {
    if (box.value === "" || isNaN(+box.value)) return;
    const range = $("#" + box.dataset.for);
    const v = Math.min(+box.max, Math.max(+box.min, +box.value));
    range.value = v;
    range.dispatchEvent(new Event("input"));
  });
  box.addEventListener("change", () => { box.value = $("#" + box.dataset.for).value; });
});

function setSubtitleValues(values) {
  Object.assign(S().subtitles, values);
  for (const [id, section, key, , out, fmt] of BIND) {
    if (section !== "subtitles" || !(key in values)) continue;
    $("#" + id).value = values[key];
    syncNumber(id, values[key]);
    if (out) $("#" + out).textContent = fmt ? fmt(values[key]) : values[key];
  }
  updatePoster();
  markDirty();
}
$("#btnSubCenter").addEventListener("click", () => setSubtitleValues({ position_x: 50 }));
$("#btnSubReset").addEventListener("click", () => {
  const d = STATUS.defaults.subtitles;
  setSubtitleValues({ size: d.size, position_x: d.position_x, position: d.position, max_width: d.max_width });
});

function setPositioning(on) {
  positioning = on && !!state.preview.url;
  const hasVideo = !!state.preview.url && !positioning;
  const v = $("#previewVideo");
  if (!hasVideo) v.pause();
  v.hidden = !hasVideo;
  $("#poster").hidden = hasVideo;
  $("#poster").classList.toggle("positioning", positioning);
  const btn = $("#btnPosition");
  btn.classList.toggle("active", positioning);
  btn.textContent = positioning ? "▶ Back to video" : "✥ Adjust positions";
  btn.hidden = !state.preview.url;
  $("#posterHint").hidden = hasVideo;
  $("#posterHint").innerHTML = positioning
    ? "Drag the title, caption or watermark, then render the preview again"
    : "<b>Preview video</b> renders the real thing · drag the title, caption or watermark to move them";
}
$("#btnPosition").addEventListener("click", () => setPositioning(!positioning));

(() => {
  const cap = $("#posterCaption");
  let grab = null;
  cap.addEventListener("pointerdown", (e) => {
    const r = cap.getBoundingClientRect();
    grab = { dx: r.left + r.width / 2 - e.clientX, dy: r.bottom - e.clientY };
    cap.setPointerCapture(e.pointerId);
    cap.classList.add("dragging");
    e.preventDefault();
  });
  cap.addEventListener("pointermove", (e) => {
    if (!grab) return;
    const box = $("#previewBox").getBoundingClientRect();
    const x = ((e.clientX + grab.dx - box.left) / box.width) * 100;
    const y = ((box.bottom - (e.clientY + grab.dy)) / box.height) * 100;
    const round = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)) * 2) / 2;
    setSubtitleValues({ position_x: round(x, 0, 100), position: round(y, 0, 92) });
  });
  const end = () => { grab = null; cap.classList.remove("dragging"); };
  cap.addEventListener("pointerup", end);
  cap.addEventListener("pointercancel", end);
})();
(() => {
  // Drag the watermark: keep its anchor (e.g. bottom-right corner of the text) under the pointer.
  const el = $("#posterWatermark");
  let grab = null;
  el.addEventListener("pointerdown", (e) => {
    const r = el.getBoundingClientRect(), [fx, fy] = ANCHORS[S().watermark.anchor] || ANCHORS.br;
    grab = { dx: r.left + r.width * fx - e.clientX, dy: r.top + r.height * fy - e.clientY };
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!grab) return;
    const box = $("#previewBox").getBoundingClientRect();
    const clamp = (v) => Math.round(Math.min(100, Math.max(0, v)) * 2) / 2;
    setWatermark({ position_x: clamp(((e.clientX + grab.dx - box.left) / box.width) * 100),
      position_y: clamp(((e.clientY + grab.dy - box.top) / box.height) * 100) });
  });
  const end = () => { grab = null; el.classList.remove("dragging"); };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
})();
(() => {
  // Drag the title by its top-center point.
  const el = $("#posterTitle");
  let grab = null;
  el.addEventListener("pointerdown", (e) => {
    const r = el.getBoundingClientRect();
    grab = { dx: r.left + r.width / 2 - e.clientX, dy: r.top - e.clientY };
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!grab) return;
    const box = $("#previewBox").getBoundingClientRect();
    const clamp = (v, hi) => Math.round(Math.min(hi, Math.max(0, v)) * 2) / 2;
    setTitle({ position_x: clamp(((e.clientX + grab.dx - box.left) / box.width) * 100, 100),
      position_y: clamp(((e.clientY + grab.dy - box.top) / box.height) * 100, 95) });
  });
  const end = () => { grab = null; el.classList.remove("dragging"); };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
})();

/* ---------------------------------------------------------------- jobs */
const JOB_LABEL = { narrate: "Generating narration", preview: "Rendering preview", export: "Exporting MP4" };

async function startJob(kind) {
  if (state.job) return;
  try {
    state.jobSnapshot = clone(state.project);
    const job = await api("/api/jobs", { kind, project: state.jobSnapshot });
    state.job = job;
    setBusy(true);
    setProgress(`${JOB_LABEL[kind]}…`, 0);
    pollJob();
  } catch (e) { showMessage("Could not start", e.message); }
}

async function pollJob() {
  let j;
  try { j = await api(`/api/jobs/${state.job.id}`); }
  catch (e) { setTimeout(pollJob, 1000); return; }
  if (j.state === "running") {
    setProgress(j.stage, j.progress);
    setTimeout(pollJob, 400);
    return;
  }
  finishJob(j);
}

function absorbNarration(result) {
  const snap = state.jobSnapshot;
  (result.scenes || []).forEach((r, i) => {
    const sc = snap.scenes[i];
    if (sc) state.narration[narrationSig(sc, snap.settings)] = { speech: r.speech, audio_url: r.audio_url, captions: r.captions };
  });
  updateTotals(); scheduleAutosave();
}

function finishJob(j) {
  const kind = state.job.kind;
  state.job = null;
  setBusy(false);
  refreshCacheInfo();
  const fill = $("#progressFill");
  if (j.state === "done") {
    absorbNarration(j.result);
    fill.className = "progress-fill done";
    if (kind === "narrate") {
      setProgress(`Narration ready — ${j.result.scenes.length} scenes, ${fmtSec(j.result.duration)} total (${j.elapsed}s)`, 1);
    } else if (kind === "preview") {
      state.preview = { url: j.result.url, sig: renderSig(state.jobSnapshot) };
      showPreview(`${j.result.url}?t=${Date.now()}`);
      updatePreviewStale();
      setProgress(`Preview ready — ${fmtSec(j.result.duration)} (rendered in ${j.elapsed}s)`, 1);
      $("#previewVideo").play().catch(() => {});
    } else {
      setProgress(`Exported ${j.result.path}`, 1);
      const btn = document.createElement("button");
      btn.className = "btn"; btn.textContent = "Show in folder";
      btn.onclick = () => api("/api/reveal", { path: j.result.path });
      showMessage("Export complete", `Saved ${j.result.width}×${j.result.height}, ${fmtSec(j.result.duration)}:\n${j.result.path}`, btn);
    }
  } else if (j.state === "cancelled") {
    fill.className = "progress-fill";
    setProgress("Cancelled. Temporary files were cleaned up.", 0);
  } else {
    fill.className = "progress-fill error";
    setProgress("Failed — see the message for details.", 1);
    showMessage(`${JOB_LABEL[kind]} failed`, j.error || "Unknown error");
  }
}

async function refreshCacheInfo() {
  try {
    const c = await api("/api/cache");
    $("#cacheInfo").textContent = `Cache: ${c.clips_mb + c.previews_mb} MB video · ${c.narration_mb} MB narration`;
  } catch { /* server busy or stopped */ }
}
$("#btnClearCache").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api("/api/cache/clear", {});
    state.preview = { url: null, sig: null };
    $("#previewVideo").removeAttribute("src");
    setPositioning(false);
    updatePreviewStale();
    await refreshCacheInfo();
    toast("Video cache cleared. Clips are rebuilt on the next preview or export.");
  } catch (err) { showMessage("Could not clear the cache", err.message); }
  finally { btn.disabled = false; }
});

function setBusy(busy) {
  ["#btnNarrate", "#btnPreview", "#btnExport"].forEach((s) => ($(s).disabled = busy));
  $("#btnCancel").hidden = !busy;
  $("#progressText").classList.toggle("active", busy);
  if (busy) $("#progressFill").className = "progress-fill";
}
function setProgress(text, p) {
  $("#progressText").textContent = text;
  $("#progressFill").style.width = `${Math.round(p * 100)}%`;
}

$("#btnNarrate").addEventListener("click", () => startJob("narrate"));
$("#btnPreview").addEventListener("click", () => startJob("preview"));
$("#btnExport").addEventListener("click", () => startJob("export"));
$("#btnCancel").addEventListener("click", () => {
  if (state.job) { api(`/api/jobs/${state.job.id}/cancel`, {}); setProgress("Cancelling…", 0); }
});

/* ---------------------------------------------------------------- projects */
function loadProject(project, path) {
  state.project = project;
  const given = project.settings || {};
  state.project.settings = {};
  for (const k of Object.keys(STATUS.defaults)) state.project.settings[k] = { ...clone(STATUS.defaults[k]), ...(given[k] || {}) };
  // Older projects used "auto"/"blur"; contain keeps the whole picture.
  if (!["contain", "cover"].includes(state.project.settings.motion.fit)) state.project.settings.motion.fit = "contain";
  state.project.scenes.forEach((sc) => { sc.id ||= uid(); sc.motion ||= "default"; sc.script ??= ""; });
  state.path = path || null;
  state.preview = { url: null, sig: null };
  $("#previewVideo").removeAttribute("src");
  setPositioning(false);
  settingsToUI();
  renderScenes();
  updatePreviewStale();
  checkImages();
}

async function checkImages() {
  const paths = state.project.scenes.map((s) => s.image).filter(Boolean);
  if (!paths.length) { state.missing.clear(); updateBanner(); return; }
  const r = await api("/api/check_images", { paths });
  const fixes = r.relinked || {};
  // Images found again in this app's media folder (app copied to another PC / folder renamed).
  state.project.scenes.forEach((sc) => { if (fixes[sc.image]) sc.image = fixes[sc.image]; });
  state.missing = new Set(r.missing);
  updateBanner();
  if (r.missing.length || Object.keys(fixes).length) renderScenes();
  if (Object.keys(fixes).length) markDirty();
}

function updateBanner() {
  const n = state.project.scenes.filter((s) => s.image && state.missing.has(s.image)).length;
  const b = $("#banner");
  b.hidden = !n;
  b.textContent = n ? `⚠ ${n} scene image${n === 1 ? " is" : "s are"} missing (moved or deleted). Click the red thumbnail${n === 1 ? "" : "s"} to locate a replacement.` : "";
}

async function saveProject(saveAs = false) {
  try {
    const r = await api("/api/project/save", { project: state.project, path: state.path, save_as: saveAs });
    if (!r.path) return;
    state.path = r.path;
    markClean();
    toast(`Saved ${r.path}`);
  } catch (e) { showMessage("Save failed", e.message); }
}

$("#btnSave").addEventListener("click", () => saveProject(false));
$("#btnSaveAs").addEventListener("click", () => saveProject(true));
$("#btnOpen").addEventListener("click", async () => {
  if (state.dirty && !(await confirmBox("Open another project?", "You have unsaved changes in this project.", "Discard and open"))) return;
  try {
    const r = await api("/api/project/open", {});
    if (!r.path) return;
    loadProject(r.project, r.path);
    markClean();
    toast(r.relinked ? `Opened ${r.path} (found ${r.relinked} moved image${r.relinked === 1 ? "" : "s"})` : `Opened ${r.path}`);
  } catch (e) { showMessage("Could not open project", e.message); }
});
$("#btnNew").addEventListener("click", async () => {
  if (state.dirty && !(await confirmBox("Start a new project?", "You have unsaved changes in this project.", "Discard and start new"))) return;
  loadProject(newProject(), null);
  markClean();
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveProject(e.shiftKey); }
});
window.addEventListener("beforeunload", () => scheduleAutosave());

/* ---------------------------------------------------------------- add / drop */
$("#addImages").addEventListener("change", (e) => { if (e.target.files.length) addImagesAsScenes(e.target.files); e.target.value = ""; });
$("#btnAddEmpty").addEventListener("click", () => {
  state.project.scenes.push({ id: uid(), image: "", image_name: "", script: "", motion: "default" });
  markDirty(); renderScenes();
  list.lastElementChild?.querySelector(".script")?.focus();
});
const pane = $(".scenes-pane"), dz = $("#dropzone");
pane.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); dz.classList.add("over"); } });
pane.addEventListener("dragleave", (e) => { if (!pane.contains(e.relatedTarget)) dz.classList.remove("over"); });
pane.addEventListener("drop", (e) => {
  dz.classList.remove("over");
  if (e.dataTransfer.files.length) { e.preventDefault(); addImagesAsScenes(e.dataTransfer.files); }
});

/* ---------------------------------------------------------------- bulk import */
const bulk = { images: [], pairs: [] };

function parseScripts(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const marker = /^\s*(?:#{1,6}\s*)?[*_]*\s*(?:scene|shot|slide)\s*#?\s*(\d+)\s*[*_]*\s*(?:[:.)\-–—]\s*[*_]*\s*(.*))?$/i;
  const bracket = /^\s*\[(\d+)\]\s*(.*)$/;
  const separator = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/;
  let blocks = [], cur = null, numbered = false, separated = false;
  const push = () => { if (cur) blocks.push(cur); cur = null; };
  for (const line of lines) {
    const m = line.match(marker) || line.match(bracket);
    if (m) { push(); cur = { number: +m[1], lines: m[2] ? [m[2]] : [] }; numbered = true; continue; }
    if (separator.test(line)) { push(); separated = true; continue; }
    if (!cur) cur = { number: null, lines: [] };
    cur.lines.push(line);
  }
  push();
  if (numbered) {
    // Ignore a title or notes written before the first "SCENE 1" marker.
    const first = blocks.findIndex((b) => b.number !== null);
    blocks = blocks.slice(first);
  } else if (!separated) {
    blocks = text.replace(/\r/g, "").split(/\n\s*\n/).map((t) => ({ number: null, lines: t.split("\n") }));
  }
  return blocks.map(finishBlock).filter((b) => b.script || b.image);
}

function finishBlock(b) {
  let image = null;
  const kept = [];
  for (const l of b.lines) {
    const im = l.match(/^\s*(?:image|img|picture|file)\s*:\s*(.+?)\s*$/i);
    if (im) { image = im[1].replace(/^["']|["']$/g, ""); continue; }
    const label = l.match(/^\s*(?:narration|script|voice\s?over|vo)\s*:\s*(.*)$/i);
    if (label) { if (label[1]) kept.push(label[1]); continue; }
    kept.push(l);
  }
  let script = kept.join("\n").trim().replace(/\n{3,}/g, "\n\n");
  // A narration wrapped in one pair of quotes (as in "Narration: "...""): the quotes are just delimiters.
  const q = script.match(/^["“]([\s\S]*)["”]$/);
  if (q && !/["“”]/.test(q[1])) script = q[1].trim();
  return { number: b.number, image, script };
}

function firstNumber(name) {
  const m = name.replace(/\.[^.]+$/, "").match(/\d+/);
  return m ? +m[0] : null;
}

function matchPairs(blocks, images) {
  const used = new Set();
  const pairs = blocks.map((b) => ({ script: b.script, number: b.number, hint: b.image, image: null }));
  const stem = (n) => n.toLowerCase().replace(/\.[^.]+$/, "");
  for (const p of pairs) {          // 1. "Image: scene_01.png" lines
    if (!p.hint) continue;
    const idx = images.findIndex((im, k) => !used.has(k) && (im.name.toLowerCase() === p.hint.toLowerCase() || stem(im.name) === stem(p.hint)));
    if (idx >= 0) { p.image = idx; used.add(idx); }
  }
  const nums = images.map((im) => firstNumber(im.name));
  const unique = nums.every((n) => n !== null) && new Set(nums).size === nums.length;
  if (unique) {                     // 2. "SCENE 3" -> scene_03.png
    for (const p of pairs) {
      if (p.image !== null || p.number === null) continue;
      const idx = nums.findIndex((n, k) => n === p.number && !used.has(k));
      if (idx >= 0) { p.image = idx; used.add(idx); }
    }
  }
  for (const p of pairs) {          // 3. everything else in order
    if (p.image !== null) continue;
    const idx = images.findIndex((_, k) => !used.has(k));
    if (idx >= 0) { p.image = idx; used.add(idx); }
  }
  images.forEach((_, k) => { if (!used.has(k)) pairs.push({ script: "", number: null, image: k }); });
  return pairs;
}

function rematch() {
  bulk.pairs = matchPairs(parseScripts($("#bulkText").value), bulk.images);
  renderPairs();
}

function renderPairs() {
  const box = $("#pairList");
  box.innerHTML = "";
  if (!bulk.pairs.length) {
    box.innerHTML = `<div class="empty-pairs">Choose images and paste scripts — the pairing appears here.</div>`;
  }
  const opts = (sel) => `<option value="">(no image)</option>` + bulk.images.map((im, k) =>
    `<option value="${k}" ${k === sel ? "selected" : ""}>${im.name}</option>`).join("");
  bulk.pairs.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "pair" + (p.image === null || !p.script.trim() ? " warn" : "");
    const im = p.image !== null ? bulk.images[p.image] : null;
    row.innerHTML = `<span class="num">${i + 1}</span>
      ${im ? `<img src="${imgUrl(im.path)}" alt="">` : `<img alt="">`}
      <select>${opts(p.image)}</select>
      <textarea placeholder="(no script — add one here or later)"></textarea>`;
    $("textarea", row).value = p.script;
    $("textarea", row).addEventListener("input", (e) => { p.script = e.target.value; summarize(); });
    $("select", row).addEventListener("change", (e) => { p.image = e.target.value === "" ? null : +e.target.value; renderPairs(); });
    box.appendChild(row);
  });
  summarize();
}

function summarize() {
  const p = bulk.pairs;
  const noImg = p.filter((x) => x.image === null).length, noScript = p.filter((x) => !x.script.trim()).length;
  const imgCounts = {};
  p.forEach((x) => { if (x.image !== null) imgCounts[x.image] = (imgCounts[x.image] || 0) + 1; });
  const dup = Object.values(imgCounts).filter((c) => c > 1).length;
  const notes = [`${p.length} scenes`];
  if (noImg) notes.push(`${noImg} without image`);
  if (noScript) notes.push(`${noScript} without script`);
  if (dup) notes.push(`${dup} image${dup === 1 ? "" : "s"} used twice`);
  $("#pairSummary").textContent = p.length ? notes.join(" · ") : "";
  $("#bulkAdd").textContent = `Add ${p.length} scene${p.length === 1 ? "" : "s"}`;
  $("#bulkAdd").disabled = !p.length;
}

$("#btnBulk").addEventListener("click", () => {
  bulk.images = []; bulk.pairs = [];
  $("#bulkText").value = ""; $("#bulkImgCount").textContent = "No images yet";
  $("#bulkReplace").checked = false;
  renderPairs();
  $("#bulkModal").hidden = false;
});
async function bulkAddImages(files) {
  try {
    bulk.images = (await uploadFiles(files)).sort(naturalSort);
    $("#bulkImgCount").textContent = `${bulk.images.length} images: ${bulk.images.map((i) => i.name).join(", ")}`;
    rematch();
  } catch (e) { showMessage("Could not load images", e.message); }
}
$("#bulkImages").addEventListener("change", (e) => { if (e.target.files.length) bulkAddImages(e.target.files); e.target.value = ""; });
const bulkDrop = $("#bulkDrop");
bulkDrop.addEventListener("dragover", (e) => { e.preventDefault(); bulkDrop.classList.add("over"); });
bulkDrop.addEventListener("dragleave", () => bulkDrop.classList.remove("over"));
bulkDrop.addEventListener("drop", (e) => { e.preventDefault(); bulkDrop.classList.remove("over"); if (e.dataTransfer.files.length) bulkAddImages(e.dataTransfer.files); });
let rematchTimer = null;
$("#bulkText").addEventListener("input", () => { clearTimeout(rematchTimer); rematchTimer = setTimeout(rematch, 250); });
$("#bulkAdd").addEventListener("click", () => {
  const scenes = bulk.pairs.map((p) => {
    const im = p.image !== null ? bulk.images[p.image] : null;
    return { id: uid(), image: im ? im.path : "", image_name: im ? im.name : "", script: p.script.trim(), motion: "default" };
  });
  if ($("#bulkReplace").checked) state.project.scenes = scenes;
  else state.project.scenes.push(...scenes);
  $("#bulkModal").hidden = true;
  markDirty(); renderScenes();
  toast(`Added ${scenes.length} scenes. Click Generate narration when you're ready.`);
});

/* ---------------------------------------------------------------- full script import */
const fullScript = { result: null, parts: [], titles: [], boundaries: [], edited: new Set() };
const BOUNDARY_LABEL = { paragraph: "paragraph break", sentence: "sentence break", clause: "splits a sentence at a comma",
  word: "splits between words", manual: "moved by you" };
const EMPTY_ASSIGN = `<div class="empty-pairs">Paste your script, then click <b>Auto assign to scenes</b>.<br>Nothing changes in your project until you click Apply.</div>`;

$("#btnFullScript").addEventListener("click", () => {
  fullScript.result = null; fullScript.parts = [];
  $("#assignList").innerHTML = EMPTY_ASSIGN;
  $("#assignNote").hidden = true; $("#assignWarnings").hidden = true;
  $("#btnApplyScript").disabled = true;
  $("#btnApplyScript").textContent = "Apply to scenes";
  $("#wordCheck").textContent = "";
  updateScriptStats();
  $("#scriptModal").hidden = false;
  $("#fullScript").focus();
});

function updateScriptStats() {
  const text = $("#fullScript").value;
  const n = state.project.scenes.length;
  if (!text.trim()) {
    $("#scriptStats").innerHTML = n
      ? `Your project has <b>${n}</b> scene${n === 1 ? "" : "s"}. Paste the full narration above.`
      : `Your project has no scenes yet. Add your images first so the script can be divided across them.`;
    return;
  }
  const a = ScriptSplit.analyse(text);
  const kind = a.labeled
    ? `<b>${a.sections.length}</b> labeled scene${a.sections.length === 1 ? "" : "s"} detected`
    : `no scene labels, so it will be divided into <b>${n}</b> part${n === 1 ? "" : "s"} (one per image)`;
  $("#scriptStats").innerHTML = `<b>${a.words}</b> words · ${a.paragraphs} paragraph${a.paragraphs === 1 ? "" : "s"} · ${kind} · project has <b>${n}</b> image${n === 1 ? "" : "s"}`;
}
$("#fullScript").addEventListener("input", updateScriptStats);

$("#btnAutoAssign").addEventListener("click", () => {
  const text = $("#fullScript").value;
  if (!text.trim()) { toast("Paste your script first."); return; }
  const r = ScriptSplit.assign(text, state.project.scenes.length);
  fullScript.result = r;
  fullScript.parts = r.parts.slice();
  fullScript.titles = r.titles.slice();
  fullScript.boundaries = r.boundaries.slice();
  fullScript.edited = new Set();
  const note = $("#assignNote");
  note.hidden = false;
  if (r.mode === "labeled") {
    note.className = "assign-note";
    note.textContent = "✓ Assigned by the scene labels in your script (SCENE 1 → scene 1, and so on). Headings are not spoken.";
  } else {
    note.className = "assign-note estimate";
    note.textContent = "≈ Estimated split. Your script has no scene labels, so it was divided in order using paragraphs, sentences and estimated speaking time. "
      + "The images were NOT analysed (no local image-understanding model is installed), so check that each narration matches its picture. Use ▲ / ▼ to shift a boundary.";
  }
  const w = $("#assignWarnings");
  w.hidden = !r.warnings.length;
  w.innerHTML = r.warnings.map((x) => `<div>⚠ ${escapeHtml(x)}</div>`).join("");
  if (!r.parts.length) { $("#assignList").innerHTML = EMPTY_ASSIGN; $("#btnApplyScript").disabled = true; return; }
  renderAssignments();
  $("#btnApplyScript").disabled = false;
});

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

function renderAssignments() {
  const box = $("#assignList");
  const scenes = state.project.scenes, parts = fullScript.parts, r = fullScript.result;
  const scroll = box.scrollTop;
  box.innerHTML = "";
  parts.forEach((text, i) => {
    if (i > 0) {
      const b = document.createElement("div");
      b.className = "boundary";
      const kind = fullScript.boundaries[i - 1];
      const uncertain = r.mode !== "labeled" && kind !== "paragraph" && kind !== "manual";
      const label = r.mode === "labeled" && kind !== "manual" ? "scene label" : `${BOUNDARY_LABEL[kind] || "boundary"}${uncertain ? " · please check" : ""}`;
      b.innerHTML = `<button class="btn" title="Move the last sentence of scene ${i} down into scene ${i + 1}">▼ move down</button>
        <span class="label ${uncertain ? "uncertain" : ""}">${label}</span>
        <button class="btn" title="Move the first sentence of scene ${i + 1} up into scene ${i}">▲ move up</button>`;
      const [down, up] = b.querySelectorAll("button");
      down.onclick = () => nudge(i - 1, -1);
      up.onclick = () => nudge(i - 1, 1);
      box.appendChild(b);
    }
    const sc = scenes[i];
    const el = document.createElement("div");
    el.className = "assign" + (!text.trim() ? " empty" : "") + (sc ? "" : " extra");
    const name = sc ? (sc.image_name || (sc.image ? sc.image.split(/[\\/]/).pop() : "no image")) : "new scene (no image)";
    const thumb = sc && sc.image && !state.missing.has(sc.image) ? `<img src="${imgUrl(sc.image)}" alt="">` : `<div class="noimg">no<br>image</div>`;
    const tags = [];
    if (fullScript.titles[i]) tags.push(`<span class="tag">${escapeHtml(fullScript.titles[i])}</span>`);
    if (fullScript.edited.has(i)) tags.push(`<span class="tag edited">edited</span>`);
    el.innerHTML = `${thumb}<div><div class="assign-head"><span class="num">${i + 1}</span><span class="name">${escapeHtml(name)}</span>${tags.join("")}
      <span class="est">${text.trim() ? `${ScriptSplit.words(text).length} words · ~${ScriptSplit.estimateSeconds(text).toFixed(0)} s` : "empty"}</span></div>
      <textarea placeholder="(no narration for this scene)"></textarea></div>`;
    const ta = $("textarea", el);
    ta.value = text;
    ta.addEventListener("input", () => { fullScript.parts[i] = ta.value; fullScript.edited.add(i); updateWordCheck(); });
    ta.addEventListener("change", renderAssignments);
    box.appendChild(el);
  });
  box.scrollTop = scroll;
  updateWordCheck();
  const n = Math.min(parts.length, scenes.length), extra = Math.max(0, parts.length - scenes.length);
  $("#btnApplyScript").textContent = `Apply to ${n} scene${n === 1 ? "" : "s"}${extra ? ` + add ${extra} new` : ""}`;
}

function nudge(i, dir) {
  fullScript.parts = ScriptSplit.moveBoundary(fullScript.parts, i, dir);
  fullScript.boundaries[i] = "manual";
  renderAssignments();
}

function updateWordCheck() {
  const orig = ScriptSplit.words(fullScript.result.analysis.body);
  const now = ScriptSplit.words(fullScript.parts.join(" "));
  const same = orig.length === now.length && orig.every((w, k) => w === now[k]);
  $("#wordCheck").textContent = same
    ? `✓ All ${orig.length} words assigned exactly once, in the original order.`
    : `✎ Edited by hand: ${now.length} words now vs ${orig.length} in the pasted script.`;
}

$("#btnApplyScript").addEventListener("click", async () => {
  const scenes = state.project.scenes, parts = fullScript.parts.map((p) => p.trim());
  const overwrite = scenes.filter((sc, i) => i < parts.length && (sc.script || "").trim() && sc.script.trim() !== parts[i]).length;
  if (overwrite && !(await confirmBox("Replace existing narration?",
    `${overwrite} scene${overwrite === 1 ? " already has" : "s already have"} narration that will be replaced.\nYou can undo this right after applying.`, "Replace narration"))) return;
  const backup = { scripts: scenes.map((sc) => ({ id: sc.id, script: sc.script })), count: scenes.length };
  parts.forEach((p, i) => {
    if (i < scenes.length) scenes[i].script = p;
    else scenes.push({ id: uid(), image: "", image_name: "", script: p, motion: "default" });
  });
  $("#scriptModal").hidden = true;
  markDirty(); renderScenes();
  toast(`Narration assigned to ${parts.length} scenes. Click Generate narration when ready.`, "Undo", () => {
    state.project.scenes.length = backup.count;
    backup.scripts.forEach((b) => { const sc = state.project.scenes.find((s) => s.id === b.id); if (sc) sc.script = b.script; });
    markDirty(); renderScenes();
    toast("Script import undone.");
  }, 20000);
});

/* ---------------------------------------------------------------- modals & toasts */
document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.hidden = true; });
});
function showMessage(title, body, extra) {
  $("#msgTitle").textContent = title;
  $("#msgBody").textContent = body;
  const slot = $("#msgExtra");
  slot.innerHTML = "";
  if (extra) slot.appendChild(extra);
  const close = $("#msgOk");
  close.textContent = "OK";
  close.className = "btn primary";
  slot.style.order = "";
  $("#msgModal").hidden = false;
}
function confirmBox(title, body, okLabel) {
  return new Promise((resolve) => {
    const ok = document.createElement("button");
    ok.className = "btn danger-solid"; ok.textContent = okLabel;
    const modal = $("#msgModal");
    const done = (v) => { modal.removeEventListener("click", onClose); resolve(v); };
    const onClose = (e) => { if (e.target === modal || e.target.closest("[data-close]")) done(false); };
    ok.onclick = () => { modal.hidden = true; done(true); };
    showMessage(title, body, ok);
    // A confirmation is "Cancel" + the action, never an ambiguous "OK" that actually cancels.
    const cancel = $("#msgOk");
    cancel.textContent = "Cancel";
    cancel.className = "btn ghost";
    $("#msgExtra").style.order = "2";      // Cancel on the left, the action on the right
    modal.addEventListener("click", onClose);
    ok.focus();
  });
}
let toastTimer = null;
function toast(text, actionLabel, action, ms = 3500) {
  const t = $("#toast");
  t.textContent = text; t.hidden = false;
  if (actionLabel) {
    const b = document.createElement("button");
    b.className = "btn"; b.textContent = actionLabel;
    b.onclick = () => { t.hidden = true; action(); };
    t.appendChild(b);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------------------------------------------------------------- first-run setup */
function showSetup(problems) {
  const box = document.createElement("span");
  box.className = "row";
  const add = (label, kind) => {
    const b = document.createElement("button");
    b.className = "btn"; b.textContent = label;
    b.onclick = async () => {
      try {
        const r = await api("/api/setup/locate", { kind });
        if (r.ok) location.reload();
      } catch (e) { showMessage("That file can't be used", e.message); }
    };
    box.appendChild(b);
  };
  if (STATUS.kokoro_error) add("Locate Kokoro…", "kokoro");
  if (!STATUS.ffmpeg) add("Locate FFmpeg…", "ffmpeg");
  const help = [];
  if (STATUS.kokoro_error) help.push("Kokoro: choose kokoro-v1_0.pth (Kokoro-82M / PyTorch) or kokoro-v1.0.onnx (ONNX).");
  if (!STATUS.ffmpeg) help.push("FFmpeg: install it with  winget install Gyan.FFmpeg  then restart StoryCraft, or locate ffmpeg.exe.");
  showMessage("Setup needed", `${problems.join("\n")}\n\n${help.join("\n")}`, box);
}

/* ---------------------------------------------------------------- boot */
async function boot() {
  STATUS = await api("/api/status");
  const h = $("#health");
  h.innerHTML = `<span class="pill ${STATUS.kokoro_error ? "bad" : "ok"}" title="${STATUS.kokoro_error || "Using your local Kokoro installation"}">${STATUS.kokoro_engine || "Kokoro"} ${STATUS.kokoro_error ? "· not ready" : `· ${STATUS.voices.length} voices`}</span>
    <span class="pill ${STATUS.ffmpeg ? "ok" : "bad"}" title="${STATUS.ffmpeg || "FFmpeg not found"}">FFmpeg</span>`;
  const problems = [STATUS.kokoro_error, STATUS.ffmpeg ? null : "FFmpeg was not found."].filter(Boolean);
  setInterval(async () => {
    try {
      const st = await api("/api/status");
      if (st.restart_needed) {
        const b = $("#banner");
        b.hidden = false;
        b.textContent = "⟳ The app was updated. Close the black StoryCraft window and run start.bat again to use the new version (your work is autosaved).";
      }
    } catch { /* server stopped */ }
  }, 15000);
  if (problems.length) showSetup(problems);
  fillStaticOptions();
  bindSettings();
  refreshCacheInfo();
  let saved = null;
  // "sidequest.autosave" is the key used before the rename to StoryCraft.
  try { saved = JSON.parse(localStorage.getItem("storycraft.autosave") || localStorage.getItem("sidequest.autosave") || "null"); } catch { saved = null; }
  if (saved && saved.project && Array.isArray(saved.project.scenes)) {
    state.narration = saved.narration || {};
    loadProject(saved.project, saved.path);
    if (saved.dirty) markDirty(); else markClean();
  } else {
    loadProject(newProject(), null);
    markClean();
  }
}
boot().catch((e) => showMessage("Could not start", e.message));
