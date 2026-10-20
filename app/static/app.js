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

/* ---- multi-select: checkboxes on the cards + a bar with bulk actions ---- */
const bulk_sel = { ids: new Set(), anchor: null };

function toggleChecked(i, on, range) {
  const scenes = state.project.scenes;
  if (range && bulk_sel.anchor !== null && bulk_sel.anchor < scenes.length) {
    const [a, b] = [Math.min(bulk_sel.anchor, i), Math.max(bulk_sel.anchor, i)];
    for (let k = a; k <= b; k++) on ? bulk_sel.ids.add(scenes[k].id) : bulk_sel.ids.delete(scenes[k].id);
  } else {
    on ? bulk_sel.ids.add(scenes[i].id) : bulk_sel.ids.delete(scenes[i].id);
  }
  bulk_sel.anchor = i;
  refreshChecks();
}

function refreshChecks() {
  const ids = new Set(state.project.scenes.map((s) => s.id));
  for (const id of [...bulk_sel.ids]) if (!ids.has(id)) bulk_sel.ids.delete(id);   // forget deleted scenes
  list.querySelectorAll(".scene").forEach((el) => {
    const on = bulk_sel.ids.has(el.dataset.id);
    $(".bulk-check", el).checked = on;
    el.classList.toggle("checked", on);
  });
  const n = bulk_sel.ids.size;
  $("#bulkBar").hidden = n === 0;
  $("#bulkCount").textContent = `${n} selected`;
  const withImage = state.project.scenes.filter((s) => bulk_sel.ids.has(s.id) && s.image).length;
  $("#bulkRemoveImages").disabled = withImage === 0;
  $("#bulkRemoveImages").textContent = `🖼 Remove ${withImage} image${withImage === 1 ? "" : "s"}`;
  $("#bulkDelete").textContent = `🗑 Delete ${n} scene${n === 1 ? "" : "s"}`;
}

$("#bulkSelectAll").addEventListener("click", () => { state.project.scenes.forEach((s) => bulk_sel.ids.add(s.id)); refreshChecks(); });
$("#bulkClear").addEventListener("click", () => { bulk_sel.ids.clear(); bulk_sel.anchor = null; refreshChecks(); });

$("#bulkRemoveImages").addEventListener("click", () => {
  const changed = state.project.scenes.filter((s) => bulk_sel.ids.has(s.id) && s.image)
    .map((s) => ({ s, image: s.image, image_name: s.image_name }));
  if (!changed.length) return;
  changed.forEach(({ s }) => { s.image = ""; s.image_name = ""; });     // files stay in media/, so Undo can restore
  markDirty(); renderScenes(); updateBanner();
  toast(`Removed ${changed.length} image${changed.length === 1 ? "" : "s"}. Narration kept.`, "Undo", () => {
    changed.forEach(({ s, image, image_name }) => Object.assign(s, { image, image_name }));
    markDirty(); renderScenes(); updateBanner();
  }, 15000);
});

$("#bulkDelete").addEventListener("click", async () => {
  const scenes = state.project.scenes;
  const doomed = scenes.map((s, k) => ({ s, k })).filter(({ s }) => bulk_sel.ids.has(s.id));
  if (!doomed.length) return;
  const n = doomed.length;
  if (!(await confirmBox(`Delete ${n} scene${n === 1 ? "" : "s"}?`,
    `${n === 1 ? "This scene" : `These ${n} scenes`} and ${n === 1 ? "its" : "their"} narration will be removed. You can undo this right after.`,
    `Delete ${n} scene${n === 1 ? "" : "s"}`))) return;
  state.project.scenes = scenes.filter((s) => !bulk_sel.ids.has(s.id));
  bulk_sel.ids.clear(); bulk_sel.anchor = null;
  markDirty(); renderScenes();
  toast(`Deleted ${n} scene${n === 1 ? "" : "s"}.`, "Undo", () => {
    doomed.forEach(({ s, k }) => state.project.scenes.splice(Math.min(k, state.project.scenes.length), 0, s));   // back in place
    markDirty(); renderScenes();
  }, 15000);
});

function renderScenes() {
  list.innerHTML = "";
  const scenes = state.project.scenes;
  if (!scenes.length) {
    list.innerHTML = `<div class="empty-state"><h3>Start your episode</h3>
      Drop your numbered scene images below, or use <b>Bulk import</b> to add images and paste all scripts at once.</div>`;
  }
  scenes.forEach((sc, i) => list.appendChild(sceneElement(sc, i)));
  refreshChecks();
  updateTotals();
  updatePoster();
}

function sceneElement(sc, i) {
  const el = $("#sceneTpl").content.firstElementChild.cloneNode(true);
  el.dataset.id = sc.id;
  const check = $(".bulk-check", el);
  check.checked = bulk_sel.ids.has(sc.id);
  el.classList.toggle("checked", check.checked);
  check.addEventListener("click", (e) => toggleChecked(i, check.checked, e.shiftKey));
  el.addEventListener("click", (e) => {
    if (e.target.closest("button, select, .thumb, .handle, .bulk-check")) return;   // buttons keep their own action
    if (state.selected !== i) selectScene(i);
  });
  el.addEventListener("focusin", (e) => { if (e.target.matches("textarea") && state.selected !== i) selectScene(i); });
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
    if (i === state.selected) updatePoster();
  });

  const motion = $(".motion", el);
  const def = MOTION_LABELS[S().motion.default] || S().motion.default;
  motion.innerHTML = `<option value="default">Default (${def})</option>` +
    STATUS.motions.map((m) => `<option value="${m}">${MOTION_LABELS[m] || m}</option>`).join("");
  motion.value = sc.motion || "default";
  motion.addEventListener("change", () => { sc.motion = motion.value; markDirty(); });

  thumb.addEventListener("click", () => pickReplacement(sc.id));
  $(".thumb-remove", thumb).addEventListener("click", (e) => {
    e.stopPropagation();                          // don't open the "replace image" picker
    const before = { image: sc.image, image_name: sc.image_name };
    sc.image = ""; sc.image_name = "";            // the file stays in media/, so Undo can restore it
    markDirty(); renderScenes(); updateBanner();
    toast(`Scene ${i + 1}: image removed.`, "Undo", () => { Object.assign(sc, before); markDirty(); renderScenes(); updateBanner(); }, 8000);
  });
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
  $(".act-image", el).addEventListener("click", () => openImageModal(i));

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
  ["igNoText", "imagegen", "no_text", "bool"], ["igUsePrev", "imagegen", "continuity", "bool"],
  ["tEnabled", "title", "enabled", "bool"], ["tFont", "title", "font"], ["tColor", "title", "color"],
  ["tHighlight", "title", "highlight"], ["tOutlineColor", "title", "outline_color"],
  ["tUpper", "title", "uppercase", "bool"], ["tBold", "title", "bold", "bool"],
  ["tOutline", "title", "outline", "num", "oTOutline", (v) => v], ["tShadow", "title", "shadow", "num", "oTShadow", (v) => v],
  ["tSpacing", "title", "line_spacing", "num"], ["tPosX", "title", "position_x", "num"], ["tPosY", "title", "position_y", "num"], ["tDuration", "title", "duration", "num"],
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
  if (!Array.isArray(t.lines) || !t.lines.length) t.lines = [{ text: "", size: 90, offset: 0 }];
  box.innerHTML = `<div class="title-lines-head"><span>Text</span><span>Size</span><span title="Move this line up (−) or down (+), in px">Move ↕</span><span></span></div>`;
  t.lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "title-line";
    row.innerHTML = `<input spellcheck="true" placeholder="${i === 0 ? "*ZOMBIE* OUTBREAK:" : "Next line"}">
      <input type="number" class="num" min="16" max="240" step="1" title="Size of this line (px)">
      <span class="off"><input type="number" class="num" min="-400" max="400" step="2" title="Move only this line up (negative) or down (positive), in px"><span>px</span></span>
      <button class="icon-btn" title="Remove this line">✕</button>`;
    const [text, size, offWrap, del] = row.children;
    const off = offWrap.querySelector("input");
    text.value = line.text || "";
    size.value = line.size || 90;
    off.value = line.offset || 0;
    off.addEventListener("input", () => { if (off.value !== "" && !isNaN(+off.value)) { line.offset = Math.max(-400, Math.min(400, +off.value)); titleChanged(); } });
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
  lines.push({ text: "", size: Math.max(30, Math.round((last?.size || 90) * 0.65)), offset: 0 });   // e.g. a smaller "PART 2"
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
    // Same layout as the renderer: a slot of size*spacing per line, text centered in it, then this line's own offset.
    const spacing = Math.min(200, Math.max(40, +t.line_spacing || 85)) / 100;
    row.style.fontSize = `calc(${line.size * scale * k}cqh)`;
    row.style.lineHeight = `calc(${line.size * spacing * scale}cqh)`;
    row.style.position = "relative";
    row.style.top = `calc(${(+line.offset || 0) * scale}cqh)`;
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
/* Which scene the middle preview shows. Click a scene card or use ◀ ▶; with a rendered,
   up-to-date preview video, selecting a scene jumps the video to where that scene starts. */
function updateStepper() {
  const n = state.project.scenes.length, i = state.selected || 0;
  $("#sceneStepLabel").textContent = n ? `Scene ${i + 1} / ${n}` : "No scenes";
  $("#btnPrevScene").disabled = i <= 0;
  $("#btnNextScene").disabled = i >= n - 1;
  document.querySelectorAll(".scene").forEach((el, k) => el.classList.toggle("selected", k === i));
}

function selectScene(i, { scroll = false } = {}) {
  const n = state.project.scenes.length;
  if (!n) return;
  state.selected = Math.min(Math.max(0, i), n - 1);
  const starts = state.preview.starts;
  const fresh = state.preview.url && state.preview.sig === renderSig(state.project);
  if (fresh && starts && starts[state.selected] !== undefined && !positioning) {
    const v = $("#previewVideo");
    v.pause();
    v.currentTime = starts[state.selected] + 0.05;
  } else if (state.preview.url && !positioning) {
    setPositioning(true);            // stale or unknown timing: show the scene as a still frame
  }
  updatePoster();
  if (scroll) list.children[state.selected]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
$("#btnPrevScene").addEventListener("click", () => selectScene((state.selected || 0) - 1, { scroll: true }));
$("#btnNextScene").addEventListener("click", () => selectScene((state.selected || 0) + 1, { scroll: true }));

/* The still preview plays the selected scene's captions one after another, like the video.
   With generated narration it uses the real captions and timing; otherwise an estimate. */
const capPlay = { key: "", phrases: [], idx: 0, timer: null };

function scenePhrases(sc) {
  const n = sc && state.narration[narrationSig(sc)];
  if (n && n.captions && n.captions.length) {
    return n.captions.map((c, k) => ({ text: c.text, secs: Math.max(0.8, (n.captions[k + 1]?.start ?? c.end + 0.4) - c.start) }));
  }
  const target = Math.max(2, +S().subtitles.words_per_caption || 5), out = [];
  for (const sentence of ScriptSplit.splitSentences((sc?.script || "").replace(/\s+/g, " ").trim())) {
    const w = sentence.split(" ").filter(Boolean);
    const parts = w.length <= target + 1 ? 1 : Math.ceil(w.length / target);
    for (let p = 0; p < parts; p++) {
      const chunk = w.slice(Math.round((p * w.length) / parts), Math.round(((p + 1) * w.length) / parts));
      if (chunk.length) out.push({ text: chunk.join(" "), secs: 0.45 + chunk.length * 0.32 });
    }
  }
  return out;
}

function playCaptions(sc) {
  const s = S().subtitles;
  const phrases = scenePhrases(sc);
  const key = JSON.stringify([sc?.id, phrases.map((p) => [p.text, +p.secs.toFixed(2)]), s.uppercase]);   // timing too: real timing replaces the estimate
  if (key !== capPlay.key) {                       // new scene or new text: start from the first caption
    capPlay.key = key; capPlay.phrases = phrases; capPlay.idx = 0;
    clearTimeout(capPlay.timer); capPlay.timer = null;
  }
  showCaption();
}

function showCaption() {
  const cap = $("#posterCaption"), list = capPlay.phrases, s = S().subtitles;
  const text = list.length ? list[capPlay.idx % list.length].text : "the world was about to end.";
  cap.textContent = s.uppercase ? text.toUpperCase() : text;
  $("#capStepLabel").textContent = list.length > 1 ? `Caption ${(capPlay.idx % list.length) + 1} / ${list.length}` : "";
  if (list.length > 1 && !capPlay.timer) {
    capPlay.timer = setTimeout(() => {
      capPlay.timer = null;
      if (!cap.classList.contains("dragging")) capPlay.idx = (capPlay.idx + 1) % list.length;   // hold while dragging
      showCaption();
    }, list[capPlay.idx % list.length].secs * 1000);
  }
}

function updatePoster() {
  const scenes = state.project.scenes;
  state.selected = Math.min(Math.max(0, state.selected || 0), Math.max(0, scenes.length - 1));
  const s = S().subtitles, current = scenes[state.selected];
  const shown = current && current.image && !state.missing.has(current.image) ? current : null;
  const img = $("#posterImg");
  $("#poster").classList.toggle("cover", S().motion.fit === "cover");
  if (shown) img.src = imgUrl(shown.image); else img.removeAttribute("src");
  updateStepper();
  const cap = $("#posterCaption");
  playCaptions(current);
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
      state.preview = { url: j.result.url, sig: renderSig(state.jobSnapshot), starts: (j.result.scenes || []).map((x) => x.start) };
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
  bulk_sel.ids.clear(); bulk_sel.anchor = null;
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

/* ---------------------------------------------------------------- scene images (ChatGPT via Codex) */
const ig = { status: null, modalIndex: null, attempts: [], chosen: null, job: null, bulk: null };
const IG = () => S().imagegen;

async function refreshImageStatus(force = false) {
  const box = $("#igStatus");
  try {
    ig.status = await api(`/api/imagegen/status${force ? "?force=true" : ""}`);
  } catch (e) { ig.status = { ready: false, message: e.message }; }
  box.classList.toggle("ok", ig.status.ready);
  box.classList.toggle("bad", !ig.status.ready);
  $("#igStatusText").textContent = ig.status.ready ? `Connected — ${ig.status.message}` : ig.status.message;
  return ig.status;
}
$("#btnIgCheck").addEventListener("click", () => { refreshImageStatus(true); loadImageModels(true); });

async function loadImageModels(force = false) {
  const sel = $("#igModel");
  try {
    const r = await api(`/api/imagegen/models${force ? "?force=true" : ""}`);
    sel.innerHTML = `<option value="">Codex default${r.default ? ` (${escapeHtml(r.default)})` : ""}</option>` +
      r.models.map((m) => `<option value="${escapeHtml(m.slug)}">${escapeHtml(m.name)}</option>`).join("");
    sel.value = r.chosen || "";
    sel.disabled = !r.models.length;
  } catch { sel.disabled = true; }
}
$("#igModel").addEventListener("change", async (e) => {
  try {
    const r = await api("/api/imagegen/model", { model: e.target.value });
    const name = e.target.selectedOptions[0]?.textContent || "Codex default";
    toast(r.chosen ? `Scene images will use ${name}.` : "Scene images will use the Codex default model.");
  } catch (err) { showMessage("Could not change the model", err.message); loadImageModels(); }
});


/* Characters + art style shared by every project ("series style", saved in series_style.json). */
let SERIES = { characters: [] };
let seriesTimer = null;
function saveSeries() {
  clearTimeout(seriesTimer);
  seriesTimer = setTimeout(() => api("/api/series_style", SERIES).catch((e) => toast("Could not save the art style: " + e.message)), 400);
}
async function loadSeries() {
  try { SERIES = await api("/api/series_style"); } catch { /* keep defaults */ }
  renderSeries();
}

function refThumb(path, onRemove) {
  const d = document.createElement("div");
  d.className = "ig-ref";
  d.innerHTML = `<img src="${imgUrl(path)}" alt=""><button title="Remove">✕</button>`;
  d.querySelector("button").onclick = onRemove;
  return d;
}

function renderSeries() {
  const list = $("#igCharacters");
  list.innerHTML = "";
  if (!SERIES.characters.length) list.innerHTML = `<div class="muted small">No characters yet. Add your main character with one or two pictures of how they look.</div>`;
  SERIES.characters.forEach((c, ci) => {
    const el = document.createElement("div");
    el.className = "ig-char" + (c.main ? " main" : "");
    el.innerHTML = `<div class="ig-char-imgs"></div>
      <div class="ig-char-fields">
        <input class="c-name" placeholder="Name, e.g. Mr. Sidequest" spellcheck="false">
        <input class="c-desc" placeholder="Look, e.g. stickman, round white head, green hoodie, brown cap">
        <label class="toggle"><input type="checkbox" class="c-main"> Main character (in every scene)</label>
      </div>
      <button class="icon-btn" title="Remove this character">✕</button>`;
    const imgs = el.querySelector(".ig-char-imgs");
    c.images.forEach((p, ii) => imgs.appendChild(refThumb(p, () => { c.images.splice(ii, 1); saveSeries(); renderSeries(); })));
    if (c.images.length < 2) {
      const add = document.createElement("label");
      add.className = "ig-ref-add"; add.title = "Add a picture of this character";
      add.innerHTML = `+<input type="file" accept=".png,.jpg,.jpeg,.webp" multiple hidden>`;
      add.querySelector("input").onchange = async (e) => {
        try { const up = await uploadFiles(e.target.files); c.images = [...c.images, ...up.map((u) => u.path)].slice(0, 2); saveSeries(); renderSeries(); }
        catch (err) { showMessage("Could not add the picture", err.message); }
      };
      imgs.appendChild(add);
    }
    const name = el.querySelector(".c-name"), desc = el.querySelector(".c-desc"), main = el.querySelector(".c-main");
    name.value = c.name; desc.value = c.description; main.checked = !!c.main;
    name.oninput = () => { c.name = name.value; saveSeries(); };
    desc.oninput = () => { c.description = desc.value; saveSeries(); };
    main.onchange = () => { SERIES.characters.forEach((o) => { o.main = o === c ? main.checked : false; }); saveSeries(); renderSeries(); };
    el.querySelector(".icon-btn").onclick = () => { SERIES.characters.splice(ci, 1); saveSeries(); renderSeries(); };
    list.appendChild(el);
  });
}
/* Art style = the images in the artstyle folder (+ optional artstyle/rules.txt). */
let ART = { images: [], rules: [], style: "", avoid: "", folder: "" };
async function loadArtStyle() {
  try { ART = await api("/api/artstyle"); } catch { /* keep the last known state */ }
  const box = $("#artThumbs");
  box.innerHTML = "";
  ART.images.slice(0, 8).forEach((p) => {
    const d = document.createElement("div");
    d.className = "ig-ref";
    d.innerHTML = `<img src="${imgUrl(p)}" alt="" title="${p.split(/[\\/]/).pop().replace(/"/g, "")}">`;
    box.appendChild(d);
  });
  if (ART.images.length > 8) box.insertAdjacentHTML("beforeend", `<div class="more">+${ART.images.length - 8}</div>`);
  const n = ART.images.length;
  $("#artInfo").innerHTML = (n
    ? `<b>${n}</b> style image${n === 1 ? "" : "s"} in the <b>artstyle</b> folder — up to 3 are sent with each image, rotating through all of them.`
    : `No images yet. Put a few images with the look you want into the <b>artstyle</b> folder (<b>Open folder</b>), then <b>Refresh</b>.`) +
    (ART.rules.length ? ` · ${ART.rules.length} rule${ART.rules.length === 1 ? "" : "s"} from rules.txt.` : " · Optional: add rules in artstyle\\rules.txt.");
  if (ig.modalIndex !== null && !$("#imgModal").hidden) updateImagePromptPreview();
}
$("#btnArtRefresh").addEventListener("click", loadArtStyle);
$("#btnArtOpen").addEventListener("click", () => api("/api/artstyle/open", {}));
window.addEventListener("focus", loadArtStyle);   // pick up images added in Explorer when you come back

/* Up to `max` folder images for scene i, rotating so every image in the folder gets used. */
function styleExamples(i, max) {
  const imgs = ART.images;
  if (imgs.length <= max) return imgs.slice();
  const start = (i * max) % imgs.length;
  return Array.from({ length: max }, (_, k) => imgs[(start + k) % imgs.length]);
}

$("#btnAddCharacter").addEventListener("click", () => {
  SERIES.characters.push({ id: uid(), name: "", description: "", main: !SERIES.characters.some((c) => c.main), images: [] });
  saveSeries(); renderSeries();
  $("#igCharacters").lastElementChild?.querySelector(".c-name")?.focus();
});

function defaultScenePrompt(sc) {
  return (sc.image_prompt || "").trim() || `Illustrate this moment of the story:\n${(sc.script || "").trim()}`;
}

const usableCharacters = () => SERIES.characters.filter((c) => (c.name || "").trim() || c.images.length);
function nameMentioned(text, name) {
  const t = ` ${text.toLowerCase()} `;
  if (name && t.includes(name.toLowerCase())) return true;
  return (name || "").split(/\s+/).some((w) => w.replace(/\W/g, "").length > 3 && new RegExp(`\\b${w.replace(/\W/g, "")}\\b`, "i").test(t));
}
/* Which characters appear: a per-scene choice if the user made one, else main + names in the narration. */
function sceneCharacters(i, promptText) {
  const sc = state.project.scenes[i], chars = usableCharacters();
  if (Array.isArray(sc.image_characters)) return chars.filter((c) => sc.image_characters.includes(c.id));
  const text = `${promptText ?? ""} ${sc.script || ""}`;
  return chars.filter((c) => c.main || nameMentioned(text, c.name));
}

/* The attached images, in order, with a line explaining each one to ChatGPT. */
function referencePlan(i, promptText) {
  const files = [], lines = [];
  const add = (paths, describe) => {
    const ok = paths.filter((p) => p && !state.missing.has(p)).slice(0, 8 - files.length);
    if (!ok.length) return;
    const a = files.length + 1, b = files.length + ok.length;
    files.push(...ok);
    lines.push(`${a === b ? `Image ${a}` : `Images ${a}–${b}`}: ${describe}`);
  };
  const ok = (sc) => sc && sc.image && !state.missing.has(sc.image);
  const prev = state.project.scenes[i - 1], prev2 = state.project.scenes[i - 2];
  const continuity = IG().continuity !== false && ok(prev);
  add(styleExamples(i, continuity ? 2 : 3), "ART STYLE examples. Copy this exact drawing style — line work, character proportions, " +
    "colors, shading and overall vibe. The new image must look like it comes from the same series.");
  // The two previous scenes: the place, and how each person who already appeared looks. Two, because the
  // last shot may be a close-up (a phone, a face) that doesn't show everyone.
  if (continuity) {
    const earlier = IG().continuity !== false && ok(prev2) ? [prev2.image] : [];
    add([...earlier, prev.image], `the PREVIOUS SCENE${earlier.length ? "S" : ""} (scene ${earlier.length ? `${i - 1} and ` : ""}${i}). ` +
      "They may show what the main character was looking at rather than where they are. Use them for continuity of the " +
      "place, layout and lighting, and to keep every person who already appeared looking THE SAME: same hairstyle, clothes, " +
      "accessories and colors (unless the narration says they changed). The basic body design always comes from the ART STYLE " +
      "examples (if an earlier image drew someone in a different style, use the series style for them). Do NOT copy their " +
      "camera angle, distance, framing, composition or poses: this image is a completely new shot of the next moment.");
  }
  for (const c of sceneCharacters(i, promptText).slice(0, 3)) {
    const nm = (c.name || "the main character").trim();
    add(c.images.slice(0, 2), `the character "${nm}"${c.description ? ` (${c.description.trim()})` : ""}. Draw ${nm} exactly like this: same design, body shape, clothes and colors.`);
  }
  return { files, lines };
}

/* ---- camera shots: every scene is a NEW shot of the story (like the next cut in a film) ---- */
const SHOTS = {
  establishing: ["Wide establishing", "WIDE ESTABLISHING SHOT: show the whole place from a distance so the viewer understands where we are; characters are small in the frame."],
  medium: ["Medium", "MEDIUM SHOT: characters from the waist up, clearly showing what they are doing."],
  closeup: ["Close-up reaction", "CLOSE-UP: tight on a character's face and upper body. Show the emotion in the series' simple style — eyebrows, a small mouth shape and body language — never a huge open mouth or an exaggerated face."],
  ots: ["Over the shoulder", "OVER-THE-SHOULDER SHOT: from behind the main character's shoulder (partly visible in the foreground), looking at what they see; that subject is sharp and in focus."],
  pov: ["Point of view", "POINT-OF-VIEW SHOT: exactly what \"you\" see, filling the frame; the main character is not visible (at most their hands)."],
  action: ["Action", "ACTION SHOT: show the action clearly, characters caught mid-movement, camera slightly tilted; simple motion lines at most."],
  low: ["Low angle", "LOW-ANGLE SHOT: camera low, looking up at the characters."],
  high: ["High angle", "HIGH-ANGLE SHOT: camera above looking down, showing the layout of the place and the characters smaller."],
  detail: ["Detail / insert", "DETAIL SHOT: a close view of the important object or small action from the narration."],
};
const SHOT_ROTATION = ["medium", "low", "closeup", "high", "ots", "action", "detail", "establishing", "pov"];
const SHOT_CUES = [
  ["ots", /\b(notic\w*|see|saw|seeing|spot\w*|look\w* (at|out|through|up)|watch\w*|star(e|ed|ing)|glanc\w*|through the window|outside)\b/],
  ["action", /\b(run|ran|running|sprint\w*|swing|swung|jump\w*|punch\w*|kick\w*|tackl\w*|fight\w*|chas\w*|throw\w*|threw|crash\w*|slam\w*|grab\w*|dodg\w*|fall\w*|fell|smash\w*|charg\w*|attack\w*|knock\w*|flying)\b/],
  ["closeup", /\b(realiz\w*|feel|felt|think|thought|panic\w*|scream\w*|shock\w*|fear|scared|terrified|regret\w*|smil\w*|laugh\w*|cr(y|ied)|sigh\w*|wonder\w*|froze|freez\w*|heart|gulp\w*)\b/],
  ["detail", /\b(phone|screen|note|keys?|sign|basket|noodles?|box|clock|wallet|receipt|label|bottle|can)\b/],
];

/* Shot for every scene up to i: the user's choice, else a cue from the narration, else the rotation —
   never the same as the scene before. */
function sceneShots(upTo) {
  const scenes = state.project.scenes, shots = [];
  for (let k = 0; k <= upTo && k < scenes.length; k++) {
    const sc = scenes[k], text = (sc.image_prompt || sc.script || "").toLowerCase();
    let shot = SHOTS[sc.shot] ? sc.shot : null;
    if (!shot) {
      shot = k === 0 ? "establishing" : (SHOT_CUES.find(([, re]) => re.test(text)) || [])[0] || SHOT_ROTATION[k % SHOT_ROTATION.length];
      if (k > 0 && shot === shots[k - 1]) {
        const alt = { ots: "pov", pov: "ots", action: "low", closeup: "medium" }[shot];
        shot = alt && alt !== shots[k - 1] ? alt : SHOT_ROTATION.find((s) => s !== shots[k - 1] && s !== shot);
      }
    }
    shots.push(shot);
  }
  return shots;
}
const sceneShot = (i) => sceneShots(i)[i];

/* The narration of the scenes before this one (most recent kept in full), so each image continues the story. */
function storySoFar(i, limit = 1800) {
  const lines = state.project.scenes.slice(0, i).map((s, k) => `Scene ${k + 1}: ${(s.script || "").replace(/\s+/g, " ").trim()}`);
  const before = lines.map((l, k) => [k, l]).filter(([, l]) => !/: $/.test(l));
  if (!before.length) return "";
  // The opening sets time and place, so it is always kept; then as many recent scenes as fit.
  const [first, ...rest] = before;
  const kept = [];
  let size = first[1].length;
  for (let k = rest.length - 1; k >= 0; k--) {
    if (size + rest[k][1].length > limit) break;
    kept.unshift(rest[k]);
    size += rest[k][1].length;
  }
  const out = [first[1]];
  if (kept.length && kept[0][0] > first[0] + 1) out.push("(scenes in between omitted)");
  else if (!kept.length && rest.length) out.push("(scenes in between omitted)");
  return [...out, ...kept.map(([, l]) => l)].join("\n");
}

/* ---- time of day: the latest time clue in the narration up to this scene ---- */
const TIME_LOOKS = {
  night: "night: dark sky, street lights and lit windows on, no daylight",
  "late night": "late night: dark sky, street lights on, very few people around, no daylight",
  evening: "evening: dusk, deep blue sky turning dark, street lights coming on",
  morning: "morning: early daylight, soft morning light",
  afternoon: "afternoon: bright daylight",
  day: "daytime: daylight",
};
function timeOfDay(i) {
  let found = null;
  state.project.scenes.slice(0, i + 1).forEach((sc, k) => {
    const t = (sc.script || "").toLowerCase();
    const clock = [...t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/g)].pop();
    let label = null, said = null;
    if (clock) {
      const h = +clock[1] % 12, pm = clock[3].startsWith("p");
      label = pm ? (h >= 5 ? "night" : "afternoon") : (h < 5 ? "late night" : "morning");
      if (pm && h >= 5 && h < 7) label = "evening";
      said = clock[0].toUpperCase().replace(/\./g, "");
    }
    const word = [...t.matchAll(/\b(midnight|tonight|night|nighttime|evening|dusk|sunset|dawn|sunrise|morning|noon|afternoon|daylight|daytime|the next day)\b/g)].pop();
    if (word && (!clock || word.index > clock.index)) {
      const w = word[1];
      label = { midnight: "late night", tonight: "night", night: "night", nighttime: "night", evening: "evening", dusk: "evening",
        sunset: "evening", dawn: "morning", sunrise: "morning", morning: "morning", noon: "day", afternoon: "afternoon",
        daylight: "day", daytime: "day", "the next day": "day" }[w];
      said = w;
    }
    if (label) found = { label, said, scene: k + 1 };
  });
  return found;
}


function fullImagePrompt(i, scenePrompt) {
  const chars = sceneCharacters(i, scenePrompt), main = chars.find((c) => c.main);
  const plan = referencePlan(i, scenePrompt);
  const total = state.project.scenes.length;
  const shots = sceneShots(i), shot = shots[i], prevShot = shots[i - 1];
  const parts = [`Create one illustration: scene ${i + 1} of ${total} of an animated story. The scenes form one continuous story, ` +
    "and each scene is a NEW SHOT — like the next panel of a comic or the next cut in a film — so viewers always see something new."];
  if (ART.style) parts.push(`ART STYLE: ${ART.style}`);
  if (ART.rules.length) parts.push(`EXTRA RULES (always follow):\n${ART.rules.map((r) => `- ${r}`).join("\n")}`);
  if (plan.lines.length) parts.push(`REFERENCE IMAGES (attached, in this order):\n${plan.lines.map((l) => `- ${l}`).join("\n")}`);
  if (chars.length) {
    parts.push(`CHARACTERS WHO CAN APPEAR (draw them as in their reference images):\n${chars.map((c) => `- ${(c.name || "Main character").trim()}${c.description ? `: ${c.description.trim()}` : ""}`).join("\n")}` +
      (main ? `\nThe story is told in the second person: "you" is ${(main.name || "the main character").trim()}.` : ""));
  }
  parts.push("SAME DESIGN FOR EVERYONE: every person in the image — including extras, crowds, victims and people in the " +
    "background — is drawn with exactly the same simple character design as the style examples and character references. " +
    "Never give anyone a different, more realistic or more detailed design (no normal skin-colored realistic faces) unless " +
    "the EXTRA RULES say otherwise for them (for example zombies). People who already appeared in earlier scenes keep exactly " +
    "the same hairstyle, clothes, accessories and colors as before (see the previous scene images and STORY SO FAR).");
  parts.push("ANATOMY: every person has exactly two arms, two hands and two legs — never an extra arm, hand or leg. Count them. " +
    "Every hand must clearly belong to one of that person's two arms. If someone holds an injured arm, their other hand " +
    "holds it, so they have no free hand left for anything else (don't also show them pushing a door or touching the counter).");
  const story = IG().continuity !== false ? storySoFar(i) : "";
  if (story) parts.push(`STORY SO FAR (already shown in earlier images, for context only):\n${story}`);
  const tod = timeOfDay(i);
  if (tod) parts.push(`TIME OF DAY: ${tod.label} (${tod.said}, from scene ${tod.scene}). Unless the narration says time has passed, ` +
    `it is still ${tod.label}. Anything outdoors or seen through windows must look like ${TIME_LOOKS[tod.label]}.`);
  parts.push(`THIS SCENE (draw this moment):\n${scenePrompt.trim()}`);
  parts.push(`CAMERA SHOT: ${SHOTS[shot][1]}` + (prevShot ? ` The previous scene was a ${SHOTS[prevShot][0].toLowerCase()} shot; ` +
    "this one must look clearly different — new camera angle, distance and framing, and new poses that match the action." : ""));
  parts.push("STYLE LOCK: the camera shot changes only the framing (angle and distance). Keep the art style, colors and lighting " +
    "exactly as described in ART STYLE and shown in the style examples — no dramatic lighting, glow, blur or extra detail.");
  parts.push("WHERE EVERYONE IS: keep every character where the story puts them. If the previous image showed something the " +
    "main character was watching (for example through a window or from a distance), the main character is still where they " +
    "were watching from — not out there — unless the narration says they moved.");
  parts.push("FOCUS: make the main subject of THIS SCENE's narration the center of attention (for example the event being noticed, " +
    "or the action happening). The main character does not have to be in the middle of the frame, and may be only partly " +
    "visible or not visible at all when the shot calls for it.");
  parts.push("COMPOSITION: exactly 16:9 widescreen (1672x941), not 3:2. Keep the important action inside the frame with a little margin.");
  const never = [(ART.avoid || "").trim(), IG().no_text ? "any text, letters, captions, speech bubbles, logos or watermarks" : ""].filter(Boolean);
  if (never.length) parts.push(`NEVER DRAW: ${never.join("; ")}.`);
  return parts.join("\n\n");
}
const sceneReferences = (i, promptText) => referencePlan(i, promptText).files;

/* Start one generation and resolve with the new image path. */
async function runImageJob(i, scenePrompt, onStage) {
  await loadArtStyle();     // re-read the artstyle folder and rules.txt right before every image
  const job = await api("/api/imagegen/jobs", { prompt: fullImagePrompt(i, scenePrompt), landscape: true,   // always 16:9
    references: sceneReferences(i, scenePrompt) });
  ig.job = job;
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const j = await api(`/api/imagegen/jobs/${job.id}`);
      if (onStage) onStage(j);
      if (j.state === "done") return j.result.path;
      if (j.state === "cancelled") throw Object.assign(new Error("Stopped."), { cancelled: true });
      if (j.state === "error") throw new Error(j.error || "Image generation failed.");
    }
  } finally { ig.job = null; }
}

function setSceneImage(sc, path, note) {
  const before = { image: sc.image, image_name: sc.image_name };
  sc.image = path;
  sc.image_name = "ChatGPT image";
  state.missing.delete(path);
  markDirty(); renderScenes();
  if (note) toast(note, "Undo", () => { Object.assign(sc, before); markDirty(); renderScenes(); }, 10000);
}

function openImageModal(i) {
  const sc = state.project.scenes[i];
  ig.modalIndex = i; ig.attempts = []; ig.chosen = null;
  $("#imgTitle").textContent = `Scene ${i + 1} image`;
  $("#imgCurrent").innerHTML = sc.image && !state.missing.has(sc.image) ? `<img src="${imgUrl(sc.image)}" alt="">` : `<span class="muted small">No image yet</span>`;
  $("#imgNew").innerHTML = `<span class="muted small">Click Generate</span>`;
  $("#imgAttempts").innerHTML = "";
  $("#imgPrompt").value = defaultScenePrompt(sc);
  $("#imgUse").disabled = true;
  $("#imgGenerate").textContent = "🎨 Generate";
  setImageBusy(false);
  renderShotPicker();
  renderImageChars();
  updateImagePromptPreview();
  $("#imgModal").hidden = false;
  if (!ig.status?.ready) $("#imgStatusLine").textContent = ig.status ? `⚠ ${ig.status.message}` : "";
}

function renderShotPicker() {
  const i = ig.modalIndex, sc = state.project.scenes[i], sel = $("#imgShot");
  const auto = (() => { const keep = sc.shot; sc.shot = null; const s = sceneShot(i); sc.shot = keep; return s; })();
  sel.innerHTML = `<option value="">Auto — ${SHOTS[auto][0]}</option>` +
    Object.entries(SHOTS).map(([k, [label]]) => `<option value="${k}">${label}</option>`).join("");
  sel.value = SHOTS[sc.shot] ? sc.shot : "";
}
$("#imgShot").addEventListener("change", (e) => {
  const sc = state.project.scenes[ig.modalIndex];
  sc.shot = e.target.value || null;
  markDirty();
  updateImagePromptPreview();
});

function renderImageChars() {
  const i = ig.modalIndex, box = $("#imgChars"), chars = usableCharacters();
  $("#imgCharsField").hidden = !chars.length;
  box.innerHTML = "";
  const active = new Set(sceneCharacters(i, $("#imgPrompt").value).map((c) => c.id));
  chars.forEach((c) => {
    const l = document.createElement("label");
    l.className = "toggle";
    l.innerHTML = `<input type="checkbox"> ${(c.name || "Unnamed character").replace(/</g, "&lt;")}${c.main ? " (main)" : ""}`;
    const cb = l.querySelector("input");
    cb.checked = active.has(c.id);
    cb.onchange = () => {
      const sc = state.project.scenes[i];
      const now = new Set(sceneCharacters(i, $("#imgPrompt").value).map((x) => x.id));
      if (cb.checked) now.add(c.id); else now.delete(c.id);
      sc.image_characters = [...now];
      markDirty();
      updateImagePromptPreview();
    };
    box.appendChild(l);
  });
}

function updateImagePromptPreview() {
  if (ig.modalIndex === null) return;
  const text = $("#imgPrompt").value || "";
  $("#imgFullPrompt").textContent = fullImagePrompt(ig.modalIndex, text);
  const plan = referencePlan(ig.modalIndex, text);
  const box = $("#imgRefsUsed");
  box.innerHTML = "";
  plan.files.forEach((p, n) => {
    const f = document.createElement("figure");
    f.innerHTML = `<img src="${imgUrl(p)}" alt=""><figcaption>Image ${n + 1}</figcaption>`;
    box.appendChild(f);
  });
  $("#imgRefNote").textContent = plan.files.length
    ? `${plan.files.length} reference image${plan.files.length === 1 ? "" : "s"} attached — each one is explained in the prompt.`
    : "Tip: add style examples and your characters in Settings → Scene images so ChatGPT matches your series.";
}
$("#imgPrompt").addEventListener("input", updateImagePromptPreview);

function setImageBusy(busy, text) {
  $("#imgProgress").hidden = !busy;
  $("#imgCancel").hidden = !busy;
  $("#imgGenerate").disabled = busy;
  if (text) $("#imgProgressText").textContent = text;
  $("#imgStatusLine").textContent = busy ? "You can close this window; generation continues." : "";
}

function showAttempt(path) {
  ig.chosen = path;
  $("#imgNew").innerHTML = `<img src="${imgUrl(path)}" alt="">`;
  $("#imgUse").disabled = false;
  document.querySelectorAll("#imgAttempts img").forEach((im) => im.classList.toggle("active", im.dataset.path === path));
}

$("#imgGenerate").addEventListener("click", async () => {
  const i = ig.modalIndex, sc = state.project.scenes[i];
  const prompt = $("#imgPrompt").value.trim();
  if (!prompt) { toast("Describe what to draw first."); return; }
  sc.image_prompt = prompt; markDirty();
  const t0 = Date.now();
  const tick = setInterval(() => $("#imgProgressText").textContent = `Generating with ChatGPT… ${Math.round((Date.now() - t0) / 1000)} s`, 1000);
  setImageBusy(true, "Starting…");
  markSceneGenerating(sc.id, true);
  try {
    const path = await runImageJob(i, prompt);
    ig.attempts.push(path);
    const im = document.createElement("img");
    im.src = imgUrl(path); im.dataset.path = path; im.title = "Use this version";
    im.onclick = () => showAttempt(path);
    $("#imgAttempts").appendChild(im);
    if (!$("#imgModal").hidden && ig.modalIndex === i) showAttempt(path);
    else setSceneImage(sc, path, `Scene ${i + 1}: new image applied.`);   // window was closed: apply directly
    $("#imgGenerate").textContent = "🎨 Generate again";
  } catch (e) {
    if (!e.cancelled) showMessage("Image generation failed", e.message);
  } finally {
    clearInterval(tick);
    setImageBusy(false);
    markSceneGenerating(sc.id, false);
  }
});
$("#imgCancel").addEventListener("click", () => { if (ig.job) api(`/api/imagegen/jobs/${ig.job.id}/cancel`, {}); });
$("#imgUse").addEventListener("click", () => {
  const sc = state.project.scenes[ig.modalIndex];
  if (!ig.chosen || !sc) return;
  setSceneImage(sc, ig.chosen, `Scene ${ig.modalIndex + 1}: new image applied.`);
  $("#imgModal").hidden = true;
  ig.modalIndex = null;
});

function markSceneGenerating(id, on) {
  const btn = document.querySelector(`.scene[data-id="${id}"] .act-image`);
  if (btn) { btn.classList.toggle("busy-gen", on); btn.textContent = on ? "🎨 Generating…" : "🎨 Image"; }
}

/* "Generate [N] missing": fill the first N scenes that have no (or a missing) image, one after another. */
try { const saved = localStorage.getItem("storycraft.genCount"); if (saved) $("#genCount").value = saved; } catch { /* default 5 */ }
$("#genCount").addEventListener("change", (e) => { try { localStorage.setItem("storycraft.genCount", e.target.value); } catch { /* ignore */ } });
$("#btnGenMissing").addEventListener("click", async () => {
  const btn = $("#btnGenMissing");
  if (ig.bulk) { ig.bulk.stop = true; if (ig.job) api(`/api/imagegen/jobs/${ig.job.id}/cancel`, {}); return; }
  const count = $("#genCount").value;
  const all = state.project.scenes.filter((s) => !s.image || state.missing.has(s.image));
  const todo = count === "all" ? all : all.slice(0, +count);   // the first N without an image, in story order
  if (!todo.length) { toast("Every scene already has an image. Use 🎨 Image on a scene to replace one."); return; }
  if ((await refreshImageStatus()).ready === false) { showMessage("ChatGPT isn't connected", ig.status.message); return; }
  if (todo.some((s) => !(s.script || "").trim() && !(s.image_prompt || "").trim())) {
    showMessage("Some scenes have no narration", "Add narration (or an image prompt) to every scene first, so ChatGPT knows what to draw."); return;
  }
  ig.bulk = { stop: false };
  $("#genCount").disabled = true;
  let done = 0;
  try {
    for (const sc of todo) {
      if (ig.bulk.stop) break;
      const i = state.project.scenes.indexOf(sc);
      if (i < 0) continue;
      btn.textContent = `■ Stop (${done + 1}/${todo.length})`;
      setProgress(`Generating image for scene ${i + 1} (${done + 1} of ${todo.length})…`, done / todo.length);
      markSceneGenerating(sc.id, true);
      try {
        const path = await runImageJob(i, defaultScenePrompt(sc));
        setSceneImage(sc, path);
        done++;
      } finally { markSceneGenerating(sc.id, false); }
    }
    setProgress(ig.bulk.stop ? `Stopped after ${done} image${done === 1 ? "" : "s"}.` : `Generated ${done} image${done === 1 ? "" : "s"}.`, 1);
  } catch (e) {
    const n = `${done} image${done === 1 ? "" : "s"}`;
    if (e.cancelled) setProgress(`Stopped after ${n}.`, 0);
    else {
      showMessage("Image generation failed", `${e.message}

${n} ${done === 1 ? "was" : "were"} generated before this.`);
      setProgress(`Generated ${n}.`, 0);
    }
  } finally {
    ig.bulk = null;
    $("#genCount").disabled = false;
    btn.textContent = "🎨 Generate";
  }
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

/* "Scenes 1–10" from [0..9] */
function sceneRanges(idx) {
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    out.push(j > k ? `${idx[k] + 1}–${idx[j] + 1}` : `${idx[k] + 1}`);
    k = j;
  }
  return out.join(", ");
}

function renderAssignments() {
  const box = $("#assignList");
  const scenes = state.project.scenes, parts = fullScript.parts, r = fullScript.result;
  const scroll = box.scrollTop;
  box.innerHTML = "";
  const kept = parts.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0);
  if (kept.length) {
    const note = document.createElement("div");
    note.className = "assign-note";
    const noScript = kept.filter((i) => !(scenes[i]?.script || "").trim());
    note.textContent = `Scene${kept.length === 1 ? "" : "s"} ${sceneRanges(kept)} ${kept.length === 1 ? "isn't" : "aren't"} in this script, so ` +
      `${kept.length === 1 ? "it stays" : "they stay"} exactly as ${kept.length === 1 ? "it is" : "they are"}.` +
      (noScript.length ? ` (Scene ${sceneRanges(noScript)} still ${noScript.length === 1 ? "has" : "have"} no narration.)` : "");
    box.appendChild(note);
  }
  parts.forEach((text, i) => {
    if (text === null) return;                          // kept scene: not shown, not changed
    if (i > 0 && parts[i - 1] !== null) {
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
  const n = parts.filter((p, i) => p !== null && i < scenes.length).length, extra = Math.max(0, parts.length - scenes.length);
  $("#btnApplyScript").textContent = n && extra ? `Update ${n} scene${n === 1 ? "" : "s"} + add ${extra} new`
    : extra ? `Add ${extra} new scene${extra === 1 ? "" : "s"}` : `Apply to ${n} scene${n === 1 ? "" : "s"}`;
}

function nudge(i, dir) {
  fullScript.parts = ScriptSplit.moveBoundary(fullScript.parts, i, dir);
  fullScript.boundaries[i] = "manual";
  renderAssignments();
}

function updateWordCheck() {
  const orig = ScriptSplit.words(fullScript.result.analysis.body);
  const now = ScriptSplit.words(fullScript.parts.filter((p) => p !== null).join(" "));
  const same = orig.length === now.length && orig.every((w, k) => w === now[k]);
  $("#wordCheck").textContent = same
    ? `✓ All ${orig.length} words assigned exactly once, in the original order.`
    : `✎ Edited by hand: ${now.length} words now vs ${orig.length} in the pasted script.`;
}

$("#btnApplyScript").addEventListener("click", async () => {
  const scenes = state.project.scenes, parts = fullScript.parts.map((p) => (p === null ? null : p.trim()));
  const overwrite = scenes.filter((sc, i) => i < parts.length && parts[i] !== null && (sc.script || "").trim() && sc.script.trim() !== parts[i]).length;
  if (overwrite && !(await confirmBox("Replace existing narration?",
    `${overwrite} scene${overwrite === 1 ? " already has" : "s already have"} narration that will be replaced.\nYou can undo this right after applying.`, "Replace narration"))) return;
  const backup = { scripts: scenes.map((sc) => ({ id: sc.id, script: sc.script })), count: scenes.length };
  let changed = 0, added = 0;
  parts.forEach((p, i) => {
    if (p === null) return;                                  // not in this script: keep as is
    if (i < scenes.length) { scenes[i].script = p; changed++; }
    else { scenes.push({ id: uid(), image: "", image_name: "", script: p, motion: "default" }); added++; }
  });
  $("#scriptModal").hidden = true;
  markDirty(); renderScenes();
  const what = [changed ? `updated ${changed} scene${changed === 1 ? "" : "s"}` : "", added ? `added ${added} new scene${added === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  toast(`Script imported: ${what}. Click Generate narration when ready.`, "Undo", () => {
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
  refreshImageStatus();
  loadImageModels();
  loadSeries();
  loadArtStyle();
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
