const params = new URLSearchParams(location.search);
const PROJECT_ID = params.get("project");

let project = null;
let ws = null; // shared wavesurfer instance (clips tab)
let wsRegionsPlugin = null;
let edWs = null; // separate wavesurfer instance (editor tab, single-region)
let edRegionsPlugin = null;
let videoEl = null; // clips tab video
let edVideoEl = null; // editor tab video
let pendingIn = null; // clip in-point staged by 'I'
let selectedLineId = null;
let selectedImageId = null; // I2-11
let overlayDragging = false; // I2-13: true between overlay pointerdown and pointerup/cancel
let lastOverlayRenderKey = null; // I2-13: skip redundant overlay DOM writes when nothing changed
let saveTimer = null;
let styleSaveTimer = null;

// I2-9: undo/redo. Snapshots of {lines, style, images}, max 100 entries.
let undoStack = [];
let redoStack = [];
const UNDO_MAX = 100;

function snapshotState() {
  return JSON.parse(JSON.stringify({ lines: project.lines, style: project.style, images: project.images }));
}

function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
}

function applySnapshot(snap) {
  project.lines = snap.lines;
  project.style = snap.style;
  project.images = snap.images || [];
  if (selectedLineId && !project.lines.find((l) => l.id === selectedLineId)) {
    selectedLineId = project.lines.length ? project.lines[0].id : null;
  }
  refreshLineUI();
  syncStylePanelFromProject();
  renderImageOverlays();
  updateOverlay();
  scheduleAutosave();
  scheduleStyleSave();
}

function doUndo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotState());
  applySnapshot(undoStack.pop());
}

function doRedo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotState());
  applySnapshot(redoStack.pop());
}

// ---------------------------------------------------------------- boot ---
document.addEventListener("DOMContentLoaded", async () => {
  if (!PROJECT_ID) {
    location.href = "/static/index.html";
    return;
  }
  document.getElementById("settings-btn").addEventListener("click", openSettingsModal);
  await loadProject();
  document.getElementById("crumb").textContent = project.video_filename || project.id;

  setupTabs();

  if (project.status === "importing") {
    // I2-1: land in the workspace immediately; the import job (proxy/audio
    // build) keeps running server-side. Show progress here instead of
    // blocking on index.html. Debug tab still works (wired independently
    // via setupTabs/showTab above).
    showImportProgress();
    showTab("clips");
    document.addEventListener("keydown", onGlobalKeydown);
    return;
  }

  // Defensive: a bug in one tab's setup must not blank the whole page (it
  // already did once — a wavesurfer .zoom() call before decode finished
  // threw and silently aborted the entire boot chain before showTab() ran).
  try {
    await setupClipsTab();
  } catch (e) {
    console.error("setupClipsTab failed", e);
  }
  try {
    await setupEditorTab();
  } catch (e) {
    console.error("setupEditorTab failed", e);
  }
  try {
    setupExportTab();
  } catch (e) {
    console.error("setupExportTab failed", e);
  }

  const initialTab = params.get("tab") || (project.status === "ready" ? "editor" : "clips");
  showTab(initialTab);

  document.addEventListener("keydown", onGlobalKeydown);
});

function showImportProgress() {
  document.getElementById("clips-normal").style.display = "none";
  document.getElementById("import-progress-panel").style.display = "block";
  const jobId = params.get("import_job");
  const msgEl = document.getElementById("ip-msg");
  const pctEl = document.getElementById("ip-pct");
  const fillEl = document.getElementById("ip-fill");
  const errEl = document.getElementById("import-panel-err");

  const finish = () => {
    // Re-run boot fresh: project.status will no longer be "importing".
    location.reload();
  };

  if (jobId) {
    pollJob(jobId, (job) => {
      msgEl.textContent = job.message || "Working…";
      const pct = Math.round((job.progress || 0) * 100);
      pctEl.textContent = pct + "%";
      fillEl.style.width = pct + "%";
    })
      .then(finish)
      .catch((e) => {
        errEl.textContent = String(e.message || e);
        errEl.style.display = "block";
      });
  } else {
    // Reopened from the recent list mid-import — we don't have the job id
    // any more, so poll the project's own status instead.
    const poll = async () => {
      try {
        const p = await Api.get(`/api/projects/${PROJECT_ID}`);
        if (p.status !== "importing") {
          finish();
          return;
        }
        msgEl.textContent = "Importing… (see Debug tab for step-by-step detail)";
      } catch (e) {
        // transient — keep polling
      }
      setTimeout(poll, 1500);
    };
    poll();
  }
}

async function loadProject() {
  project = await Api.get(`/api/projects/${PROJECT_ID}`);
}

async function saveProjectPatch(patch) {
  const updated = await Api.patch(`/api/projects/${PROJECT_ID}`, patch);
  project = updated;
  return updated;
}

// ---------------------------------------------------------------- tabs ---
function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });
}

let debugInterval = null;
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.style.display = p.dataset.panel === name ? "block" : "none"));
  // I2-12: switching tabs must not leave the previous tab's video playing —
  // pause both unconditionally (pausing an already-paused video is a no-op).
  if (videoEl) videoEl.pause();
  if (edVideoEl) edVideoEl.pause();
  currentTab = name;
  const sidebar = document.getElementById("shortcut-sidebar");
  const layout = document.querySelector(".workspace-layout");
  if (sidebar && layout) {
    const showSidebar = name === "clips" || name === "editor";
    sidebar.hidden = !showSidebar;
    layout.classList.toggle("shortcut-sidebar-hidden", !showSidebar);
    document.querySelectorAll("[data-keys-for]").forEach((b) => (b.hidden = b.dataset.keysFor !== name));
  }
  const styleRail = document.getElementById("style-rail");
  if (styleRail && layout) {
    const showRail = name === "editor";
    styleRail.hidden = !showRail;
    layout.classList.toggle("style-rail-visible", showRail);
    document.querySelector(".workspace-page")?.classList.toggle("style-rail-on", showRail);
  }
  if (name === "debug") {
    const body = document.querySelector('[data-panel="debug"] .c-body');
    refreshDebugConsole(PROJECT_ID, body);
    if (!debugInterval) debugInterval = setInterval(() => refreshDebugConsole(PROJECT_ID, body), 2000);
    const copyBtn = document.querySelector(".copy-log-btn");
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(body.innerText);
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => (copyBtn.textContent = "Copy for Claude ⧉"), 1500);
    };
  }
  // v0.2.5 bug fix: WaveSurfer.create() is called for the editor tab while
  // its panel is still display:none (setupEditorTab() runs before the first
  // showTab()), so the renderer's ResizeObserver sees a 0x0 box and never
  // paints any <canvas> elements — they stay permanently empty even after
  // the panel becomes visible, because nothing tells the renderer to
  // recompute. WaveSurfer.setOptions({}) merges in no new options but does
  // call the renderer's reRender(), which is the one documented way (short
  // of destroying/recreating the instance) to force a fresh layout+paint
  // pass. Only needs to run once per instance, the first time its tab is
  // actually shown with a real (non-zero) container size.
  if (name === "editor" && edWs && !edWsRendered) {
    edWs.setOptions({});
    edWsRendered = true;
  }
  if (name === "clips" && ws && !wsRendered) {
    ws.setOptions({});
    wsRendered = true;
  }
}
let currentTab = "clips";
let wsRendered = false;
let edWsRendered = false;

// ============================================ shared waveform helpers ===
// I2-3: smooth cursor tracking while the video plays (timeupdate alone is
// too coarse). One-directional (video -> waveform cursor) so it cannot
// feed back into the existing reverse-direction (waveform -> video) sync,
// which keeps its own 0.25s epsilon guard.
function startCursorSync(videoElRef, wsInstance) {
  function loop() {
    if (videoElRef && !videoElRef.paused && !videoElRef.ended) {
      if (typeof wsInstance.setTime === "function") {
        wsInstance.setTime(videoElRef.currentTime);
      } else {
        const dur = wsInstance.getDuration();
        if (dur) wsInstance.seekTo(videoElRef.currentTime / dur);
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// I2-7: zoom (px/s) shared between the clips-tab and editor-tab waveforms.
const zoomLevels = { clips: 40, editor: 40 };

function currentZoom(kind) {
  return zoomLevels[kind] || 40;
}

function setupZoomControls(kind, wsInstance, containerSelector) {
  const readout = document.getElementById(`${kind}-zoom-readout`);
  const applyZoom = (px) => {
    zoomLevels[kind] = Math.max(10, Math.min(500, px));
    try {
      // wavesurfer throws "No audio loaded" if called before decoding
      // finishes (e.g. the very first render, or a fast click right after
      // create()). minPxPerSec at create() already set the initial zoom, so
      // swallowing this is safe — the next user-triggered zoom will apply.
      wsInstance.zoom(zoomLevels[kind]);
    } catch (e) {
      // not ready yet — ignore
    }
    if (readout) readout.textContent = `${Math.round(zoomLevels[kind])} px/s`;
  };
  if (readout) readout.textContent = `${Math.round(zoomLevels[kind])} px/s`;

  document.querySelectorAll(`.zoom-btn[data-track="${kind}"]`).forEach((btn) => {
    btn.addEventListener("click", () => {
      applyZoom(zoomLevels[kind] * (btn.dataset.zoom === "in" ? 1.3 : 1 / 1.3));
    });
  });

  const container = document.querySelector(containerSelector);
  if (container) {
    container.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        applyZoom(zoomLevels[kind] * (e.deltaY < 0 ? 1.3 : 1 / 1.3));
      },
      { passive: false }
    );
  }
}

// I2-8: spectrogram toggle on the editor-tab waveform.
let spectrogramPlugin = null;
function setupSpectrogramToggle() {
  const btn = document.getElementById("spectrogram-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const SpecCtor = (window.WaveSurfer && window.WaveSurfer.Spectrogram) || window.Spectrogram;
    if (spectrogramPlugin) {
      spectrogramPlugin.destroy();
      spectrogramPlugin = null;
      btn.classList.remove("on");
      return;
    }
    if (!SpecCtor) {
      console.error("Spectrogram plugin not loaded");
      return;
    }
    spectrogramPlugin = edWs.registerPlugin(SpecCtor.create({ height: 100, labels: false }));
    btn.classList.add("on");
  });
}

// ======================================================= 01 CLIPS TAB ===
async function setupClipsTab() {
  const well = document.getElementById("well");
  well.innerHTML = "";
  videoEl = document.createElement("video");
  videoEl.controls = true;
  videoEl.src = `/api/projects/${PROJECT_ID}/preview`;
  well.appendChild(videoEl);
  videoEl.addEventListener("timeupdate", () => {
    if (ws && Math.abs(ws.getCurrentTime() - videoEl.currentTime) > 0.25) {
      const dur = ws.getDuration() || project.video_duration;
      if (dur) ws.seekTo(videoEl.currentTime / dur);
    }
    updatePendingRegion();
  });

  document.getElementById("tc-end").textContent = fmtTime(project.video_duration);

  ws = WaveSurfer.create({
    container: "#track",
    height: 62,
    waveColor: "#5B3FD4",
    progressColor: "#5B3FD4",
    cursorWidth: 2,
    cursorColor: "#FF5C1F",
    minPxPerSec: currentZoom("clips"),
    autoScroll: true,
    autoCenter: true,
    url: `/api/projects/${PROJECT_ID}/audio`,
  });
  wsRegionsPlugin = ws.registerPlugin(WaveSurfer.Regions.create());

  ws.on("interaction", () => {
    videoEl.currentTime = ws.getCurrentTime();
  });

  startCursorSync(videoEl, ws);
  setupZoomControls("clips", ws, "#track");
  setupPanControls(ws, "#track");

  // v0.2.1: saved regions can only be drawn once the audio is decoded —
  // adding them right after create() places them on a 0-length timeline,
  // which made reloaded clips invisible (the data itself was fine).
  ws.on("decode", () => renderClipRegionsFromClips());
  wsRegionsPlugin.on("region-updated", (region) => {
    if (region.id !== PENDING_REGION_ID) syncRegionsToClips();
  });

  renderClipsTable();
  updateClipSummary();

  document.getElementById("clear-clips-btn").addEventListener("click", async () => {
    cancelPendingIn();
    wsRegionsPlugin.getRegions().forEach((r) => r.remove());
    await saveProjectPatch({ clips: [] });
    renderClipsTable();
    updateClipSummary();
  });

  document.getElementById("translate-all-btn").addEventListener("click", () => runPipeline([]));
  document.getElementById("translate-clips-btn").addEventListener("click", () => runPipeline(project.clips));

  if (!project.clips.length) document.getElementById("translate-clips-btn").disabled = true;
}

function syncRegionsToClips() {
  const regions = wsRegionsPlugin
    .getRegions()
    .filter((r) => r.id !== PENDING_REGION_ID)
    .sort((a, b) => a.start - b.start);
  project.clips = regions.map((r, i) => ({
    start: r.start,
    end: r.end,
    title: project.clips[i]?.title || `Clip ${i + 1}`,
    note: project.clips[i]?.note || "",
  }));
  saveProjectPatch({ clips: project.clips });
  renderClipsTable();
  updateClipSummary();
}

// --- v0.2.1: pending in-point marker (pressing I stages a clip visually) ---
const PENDING_REGION_ID = "pending-in";
let pendingRegion = null;

function setPendingIn(t) {
  cancelPendingIn();
  pendingIn = t;
  pendingRegion = wsRegionsPlugin.addRegion({
    id: PENDING_REGION_ID,
    start: t,
    end: t + 0.05,
    color: "rgba(255,92,31,0.30)",
    content: "IN · O commits",
    drag: false,
    resize: false,
  });
  const lab = document.getElementById("clip-summary");
  lab.textContent = `IN at ${fmtTime(t)} — O commits · Esc cancels`;
  lab.style.color = "var(--orange)";
}

function updatePendingRegion() {
  if (!pendingRegion || pendingIn === null || !videoEl) return;
  const t = videoEl.currentTime;
  if (t > pendingIn + 0.05) {
    try {
      pendingRegion.setOptions({ start: pendingIn, end: t });
    } catch (e) {
      /* older regions builds without setOptions — marker stays a tick */
    }
  }
}

function cancelPendingIn() {
  if (pendingRegion) {
    try { pendingRegion.remove(); } catch (e) { /* already gone */ }
  }
  pendingRegion = null;
  pendingIn = null;
  const lab = document.getElementById("clip-summary");
  if (lab) lab.style.color = "";
  updateClipSummary();
}

// --- v0.2.1: waveform panning (right-mouse drag + arrow keys) ---
function wsScrollBy(wsInstance, dx) {
  try {
    wsInstance.setScroll(Math.max(0, wsInstance.getScroll() + dx));
  } catch (e) {
    /* not decoded yet — nothing to pan */
  }
}

function panByViewport(wsInstance, containerSelector, fraction) {
  const container = document.querySelector(containerSelector);
  const w = container ? container.clientWidth : 600;
  wsScrollBy(wsInstance, w * fraction);
}

function setupPanControls(wsInstance, containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.addEventListener("contextmenu", (e) => e.preventDefault());
  let panning = false;
  let lastX = 0;
  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 2) return;
    panning = true;
    lastX = e.clientX;
    e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!panning) return;
    wsScrollBy(wsInstance, lastX - e.clientX);
    lastX = e.clientX;
  });
  window.addEventListener("pointerup", () => {
    panning = false;
  });
}

function addClipRegion(start, end) {
  wsRegionsPlugin.addRegion({
    start,
    end,
    color: "rgba(53,217,192,0.25)",
    content: `Clip ${wsRegionsPlugin.getRegions().length + 1}`,
    drag: true,
    resize: true,
  });
  syncRegionsToClips();
}

function updateClipSummary() {
  const total = project.clips.reduce((s, c) => s + (c.end - c.start), 0);
  document.getElementById("clip-summary").textContent = project.clips.length
    ? `${project.clips.length} clip${project.clips.length > 1 ? "s" : ""} · ${fmtTime(total)} selected`
    : "";
  document.getElementById("translate-clips-btn").disabled = project.clips.length === 0;
}

function renderClipsTable() {
  const table = document.getElementById("clips-table");
  table.querySelectorAll("tr:not(:first-child)").forEach((r) => r.remove());
  project.clips.forEach((clip, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${i + 1}</td>
      <td class="mono">${fmtTime(clip.start)}</td>
      <td class="mono">${fmtTime(clip.end)}</td>
      <td><input type="text" class="fval" style="width:140px" value="${escapeAttr(clip.title)}" data-i="${i}" data-f="title"></td>
      <td><input type="text" class="fval" style="width:100%" value="${escapeAttr(clip.note)}" data-i="${i}" data-f="note"></td>
      <td><button class="style-chip" data-del="${i}">Delete</button></td>`;
    table.appendChild(tr);
  });
  table.querySelectorAll("input[data-f]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const i = parseInt(inp.dataset.i);
      project.clips[i][inp.dataset.f] = inp.value;
      saveProjectPatch({ clips: project.clips });
    });
  });
  table.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.del);
      project.clips.splice(i, 1);
      renderClipRegionsFromClips();
      saveProjectPatch({ clips: project.clips });
      renderClipsTable();
      updateClipSummary();
    });
  });
}

function renderClipRegionsFromClips() {
  wsRegionsPlugin.getRegions().forEach((r) => r.remove());
  project.clips.forEach((clip, i) => {
    wsRegionsPlugin.addRegion({ start: clip.start, end: clip.end, color: "rgba(53,217,192,0.25)", content: `Clip ${i + 1}`, drag: true, resize: true });
  });
}

function escapeAttr(s) {
  return String(s || "").replace(/"/g, "&quot;");
}

function updatePlayhead() {
  // wavesurfer's own cursor already tracks position via seekTo sync; nothing extra needed here.
}

async function runPipeline(clipsToUse) {
  document.getElementById("pipeline-err").style.display = "none";
  await saveProjectPatch({ clips: clipsToUse });
  document.getElementById("translate-all-btn").disabled = true;
  document.getElementById("translate-clips-btn").disabled = true;
  document.getElementById("pipeline-progress").style.display = "block";
  try {
    const { job_id } = await Api.post(`/api/projects/${PROJECT_ID}/pipeline`, {});
    await pollJob(job_id, (job) => {
      document.getElementById("pipeline-msg").textContent = job.message || "Working…";
      const pct = Math.round((job.progress || 0) * 100);
      document.getElementById("pipeline-pct").textContent = pct + "%";
      document.getElementById("pipeline-fill").style.width = pct + "%";
    });
    location.href = `/static/workspace.html?project=${PROJECT_ID}&tab=editor`;
  } catch (e) {
    document.getElementById("pipeline-err").textContent = String(e.message || e);
    document.getElementById("pipeline-err").style.display = "block";
    document.getElementById("translate-all-btn").disabled = false;
    document.getElementById("translate-clips-btn").disabled = project.clips.length === 0;
  }
}

// ====================================================== 02 EDITOR TAB ===
async function setupEditorTab() {
  const well = document.getElementById("ed-well");
  well.innerHTML = "";
  edVideoEl = document.createElement("video");
  edVideoEl.controls = true;
  edVideoEl.src = `/api/projects/${PROJECT_ID}/preview`;
  well.appendChild(edVideoEl);
  const overlay = document.createElement("div");
  overlay.id = "sub-overlay";
  overlay.className = "sub-overlay";
  well.appendChild(overlay);

  edVideoEl.addEventListener("timeupdate", updateOverlay);
  setInterval(updateOverlay, 100);

  edWs = WaveSurfer.create({
    container: "#ed-track",
    height: 70,
    waveColor: "#5B3FD4",
    progressColor: "#5B3FD4",
    cursorWidth: 2,
    cursorColor: "#FF5C1F",
    minPxPerSec: currentZoom("editor"),
    autoScroll: true,
    autoCenter: true,
    url: `/api/projects/${PROJECT_ID}/audio`,
  });
  edRegionsPlugin = edWs.registerPlugin(WaveSurfer.Regions.create());
  edWs.on("interaction", () => {
    edVideoEl.currentTime = edWs.getCurrentTime();
  });
  edVideoEl.addEventListener("timeupdate", () => {
    const dur = edWs.getDuration() || project.video_duration;
    if (dur && Math.abs(edWs.getCurrentTime() - edVideoEl.currentTime) > 0.25) edWs.seekTo(edVideoEl.currentTime / dur);
  });

  startCursorSync(edVideoEl, edWs);
  setupZoomControls("editor", edWs, "#ed-track");
  setupPanControls(edWs, "#ed-track");
  setupSpectrogramToggle();

  edRegionsPlugin.on("region-updated", (region) => {
    // I2-9: "region-updated" already fires once per drag/resize gesture (it's
    // wired to the region's own "update-end" event in the vendored plugin),
    // so this one call is naturally "one drag = one snapshot".
    if (!selectedLineId) return;
    const line = project.lines.find((l) => l.id === selectedLineId);
    if (!line) return;
    pushUndo();
    line.start = region.start;
    line.end = region.end;
    fillInspector(line);
    renderLinesTable();
    scheduleAutosave();
  });

  renderLinesTable();
  bindInspectorEvents();
  bindOverrideEvents();
  // v0.2.1: same decode-race as the clips regions — the initial line region
  // is invisible if drawn before the audio finishes decoding.
  if (project.lines.length) edWs.on("decode", () => selectLine(project.lines[0].id));

  setupStyleRail();
  setupStylePanel();
  setupOverlayDrag();
  setupImageDropZone();
  bindImageRowEvents();
  renderImageOverlays();

  document.getElementById("new-line-btn").addEventListener("click", createNewLineAtPlayhead);
  document.getElementById("split-btn").addEventListener("click", splitAtPlayhead);
  document.getElementById("merge-btn").addEventListener("click", mergeWithNext);
  document.getElementById("insert-btn").addEventListener("click", insertAfter);
  document.getElementById("delete-btn").addEventListener("click", deleteSelected);

  setupTranslationBanner();
}

// ============================================== v0.2.5 right-side style rail ===
// Two independently-collapsible ribbons (global style / per-line override)
// mirroring the left shortcut sidebar. Open/closed state persists per-ribbon
// in localStorage so it survives reloads.
function setupStyleRail() {
  document.querySelectorAll(".rail-ribbon").forEach((ribbon) => {
    const key = ribbon.dataset.ribbon;
    const head = ribbon.querySelector(".rail-ribbon-head");
    const storeKey = `subtitler-rail-ribbon-${key}`;
    const stored = localStorage.getItem(storeKey);
    const open = stored !== null ? stored === "1" : ribbon.dataset.defaultOpen === "1";
    ribbon.classList.toggle("open", open);
    head.addEventListener("click", () => {
      const isOpen = ribbon.classList.toggle("open");
      localStorage.setItem(storeKey, isOpen ? "1" : "0");
    });
  });
}

// ============================================== I2-10 style panel (global) ===
function setupStylePanel() {
  syncStylePanelFromProject();

  bindGlobalStyleField("gs-font", (v) => (project.style.font = v || project.style.font));
  bindGlobalStyleField("gs-size", (v) => (project.style.size = parseInt(v, 10) || project.style.size));
  bindGlobalStyleField("gs-color", (v) => (project.style.color = v));
  bindGlobalStyleField("gs-outline-color", (v) => (project.style.outline_color = v));
  bindGlobalStyleField("gs-outline-width", (v) => (project.style.outline_width = Math.max(0, Math.min(6, parseInt(v, 10) || 0))));
  bindGlobalStyleField("gs-margin-v", (v) => (project.style.margin_v = parseInt(v, 10) || 0));

  document.getElementById("gs-position").addEventListener("change", () => {
    const val = document.getElementById("gs-position").value;
    pushUndo();
    if (val === "bottom" || val === "top") {
      project.style.position = val;
      project.style.pos_x = null;
      project.style.pos_y = null;
    }
    scheduleStyleSave();
    updateOverlay();
  });

  document.getElementById("gs-bilingual-chip").addEventListener("click", () => {
    pushUndo();
    project.style.bilingual = !project.style.bilingual;
    document.getElementById("gs-bilingual-chip").classList.toggle("on", project.style.bilingual);
    scheduleStyleSave();
    updateOverlay();
  });
}

function bindGlobalStyleField(id, apply) {
  const el = document.getElementById(id);
  let pushed = false;
  el.addEventListener("focus", () => (pushed = false));
  el.addEventListener("input", () => {
    if (!pushed) {
      pushUndo();
      pushed = true;
    }
    apply(el.value);
    updateOverlay();
    scheduleStyleSave();
  });
}

function syncStylePanelFromProject() {
  const s = project.style;
  document.getElementById("gs-font").value = s.font;
  document.getElementById("gs-size").value = s.size;
  document.getElementById("gs-color").value = s.color;
  document.getElementById("gs-outline-color").value = s.outline_color;
  document.getElementById("gs-outline-width").value = s.outline_width;
  document.getElementById("gs-margin-v").value = s.margin_v;
  document.getElementById("gs-position").value = s.pos_x != null && s.pos_y != null ? "custom" : s.position;
  document.getElementById("gs-bilingual-chip").classList.toggle("on", !!s.bilingual);
}

// ============================================== I2-10 per-line overrides ===
function ensureLineStyle(line) {
  if (!line.style) {
    line.style = { font: null, size: null, color: null, outline_color: null, position: null, pos_x: null, pos_y: null };
  }
  return line.style;
}

function bindOverrideEvents() {
  bindOverrideField("ov-font", "font", false);
  bindOverrideField("ov-size", "size", true);
  bindOverrideField("ov-color", "color", false);
  bindOverrideField("ov-outline-color", "outline_color", false);

  document.getElementById("ov-position").addEventListener("change", () => {
    const line = currentLine();
    if (!line) return;
    pushUndo();
    const val = document.getElementById("ov-position").value;
    ensureLineStyle(line).position = val || null;
    renderLinesTable();
    selectRowOnly(line.id);
    updateOverlay();
    scheduleAutosave();
  });

  document.getElementById("ov-reset-btn").addEventListener("click", () => {
    const line = currentLine();
    if (!line) return;
    pushUndo();
    line.style = null;
    fillInspector(line);
    renderLinesTable();
    updateOverlay();
    scheduleAutosave();
  });
}

function bindOverrideField(id, field, isNumber) {
  const el = document.getElementById(id);
  let pushed = false;
  el.addEventListener("focus", () => (pushed = false));
  el.addEventListener("input", () => {
    const line = currentLine();
    if (!line) return;
    if (!pushed) {
      pushUndo();
      pushed = true;
    }
    const raw = el.value;
    const val = raw === "" ? null : isNumber ? parseInt(raw, 10) : raw;
    ensureLineStyle(line)[field] = val;
    renderLinesTable();
    selectRowOnly(line.id);
    updateOverlay();
    scheduleAutosave();
  });
}

// ==================================================== I2-10 drag-to-position ===
function setupOverlayDrag() {
  const overlay = document.getElementById("sub-overlay");
  let dragging = false;
  let altDrag = false;
  let pushedForDrag = false;

  overlay.addEventListener("pointerdown", (e) => {
    if (!overlay.dataset.lineId) return;
    dragging = true;
    overlayDragging = true; // I2-13: updateOverlay() must not fight the drag while this is true
    altDrag = e.altKey;
    pushedForDrag = false;
    overlay.classList.add("dragging");
    try {
      overlay.setPointerCapture(e.pointerId);
    } catch (err) {
      // ignore — not fatal, pointermove/pointerup listeners still work as
      // long as the pointer stays over the element
    }
    e.preventDefault();
  });

  overlay.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    if (!pushedForDrag) {
      pushUndo();
      pushedForDrag = true;
    }
    const well = document.getElementById("ed-well");
    const rect = well.getBoundingClientRect();
    const px = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const py = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
    const posX = Math.min(0.98, Math.max(0.02, px / rect.width));
    const posY = Math.min(0.98, Math.max(0.05, py / rect.height));

    overlay.classList.add("custom-pos");
    overlay.classList.remove("top");
    overlay.style.left = `${posX * 100}%`;
    overlay.style.bottom = `${(1 - posY) * 100}%`;
    overlay.style.transform = "translateX(-50%)";
    overlay.dataset.dragPosX = posX;
    overlay.dataset.dragPosY = posY;
  });

  const finishDrag = () => {
    if (!dragging) return;
    dragging = false;
    overlay.classList.remove("dragging");
    if (overlay.dataset.dragPosX === undefined) {
      overlayDragging = false;
      return;
    }
    const posX = parseFloat(overlay.dataset.dragPosX);
    const posY = parseFloat(overlay.dataset.dragPosY);
    delete overlay.dataset.dragPosX;
    delete overlay.dataset.dragPosY;

    const line = project.lines.find((l) => l.id === overlay.dataset.lineId);
    const lineHasOwnPos = !!(line && line.style && line.style.pos_x != null);
    if (altDrag || lineHasOwnPos) {
      if (line) {
        ensureLineStyle(line).pos_x = posX;
        ensureLineStyle(line).pos_y = posY;
      }
      scheduleAutosave();
    } else {
      project.style.pos_x = posX;
      project.style.pos_y = posY;
      syncStylePanelFromProject();
      scheduleStyleSave();
    }
    overlayDragging = false;
    lastOverlayRenderKey = null; // force a fresh render — the drag applied the same css props, but the cache doesn't know that
    updateOverlay();
  };
  overlay.addEventListener("pointerup", finishDrag);
  overlay.addEventListener("pointercancel", finishDrag);
}

// ======================================================= I2-11 image overlays ===
function setupImageDropZone() {
  const well = document.getElementById("ed-well");
  well.addEventListener("dragover", (e) => {
    e.preventDefault();
    well.classList.add("drop-target");
  });
  well.addEventListener("dragleave", () => well.classList.remove("drop-target"));
  well.addEventListener("drop", async (e) => {
    e.preventDefault();
    well.classList.remove("drop-target");
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /^image\/(png|jpe?g|webp)/.test(f.type));
    for (const file of files) {
      await uploadImage(file);
    }
  });
}

async function uploadImage(file) {
  pushUndo();
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch(`/api/projects/${PROJECT_ID}/images`, { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    project = await res.json();
    renderImageOverlays();
  } catch (e) {
    alert("Image upload failed: " + (e.message || e));
  }
}

function renderImageOverlays() {
  const well = document.getElementById("ed-well");
  well.querySelectorAll(".img-overlay").forEach((el) => el.remove());
  project.images.forEach((im) => {
    const el = document.createElement("div");
    el.className = "img-overlay" + (im.id === selectedImageId ? " selected" : "");
    el.dataset.imageId = im.id;
    el.style.left = `${im.x * 100}%`;
    el.style.top = `${im.y * 100}%`;
    el.style.width = `${im.width * 100}%`;
    el.innerHTML = `<img src="/api/projects/${PROJECT_ID}/images/${im.filename}" draggable="false">
      <button type="button" class="img-del" title="Delete image">×</button>
      <div class="img-resize" title="Resize"></div>`;
    well.appendChild(el);
    bindImageOverlayEvents(el, im);
  });
  updateImageRow();
}

function bindImageOverlayEvents(el, im) {
  // Bind by id, not object reference: saveProjectPatch()/applySnapshot()
  // replace `project` (and therefore project.images) wholesale, which would
  // otherwise leave these closures mutating a detached, orphaned object.
  const imageId = im.id;
  const findImage = () => project.images.find((x) => x.id === imageId);

  el.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("img-resize") || e.target.classList.contains("img-del")) return;
    const cur = findImage();
    if (!cur) return;
    selectedImageId = imageId;
    document.querySelectorAll(".img-overlay").forEach((o) => o.classList.toggle("selected", o.dataset.imageId === imageId));
    updateImageRow();

    const well = document.getElementById("ed-well");
    const rect = well.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = cur.x;
    const origY = cur.y;
    let pushed = false;
    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {
      // ignore
    }

    const onMove = (ev) => {
      const target = findImage();
      if (!target) return;
      if (!pushed) {
        pushUndo();
        pushed = true;
      }
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      target.x = Math.min(0.98, Math.max(0, origX + dx));
      target.y = Math.min(0.95, Math.max(0, origY + dy));
      el.style.left = `${target.x * 100}%`;
      el.style.top = `${target.y * 100}%`;
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      if (pushed) saveProjectPatch({ images: project.images }).then(() => renderImageOverlays());
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    e.preventDefault();
    e.stopPropagation();
  });

  const resizeHandle = el.querySelector(".img-resize");
  resizeHandle.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const cur = findImage();
    if (!cur) return;
    const well = document.getElementById("ed-well");
    const rect = well.getBoundingClientRect();
    const startX = e.clientX;
    const origW = cur.width;
    let pushed = false;
    try {
      resizeHandle.setPointerCapture(e.pointerId);
    } catch (err) {
      // ignore
    }
    const onMove = (ev) => {
      const target = findImage();
      if (!target) return;
      if (!pushed) {
        pushUndo();
        pushed = true;
      }
      const dx = (ev.clientX - startX) / rect.width;
      target.width = Math.min(0.95, Math.max(0.03, origW + dx));
      el.style.width = `${target.width * 100}%`;
    };
    const onUp = () => {
      resizeHandle.removeEventListener("pointermove", onMove);
      resizeHandle.removeEventListener("pointerup", onUp);
      if (pushed) saveProjectPatch({ images: project.images }).then(() => renderImageOverlays());
    };
    resizeHandle.addEventListener("pointermove", onMove);
    resizeHandle.addEventListener("pointerup", onUp);
  });

  el.querySelector(".img-del").addEventListener("click", async (e) => {
    e.stopPropagation();
    pushUndo();
    project.images = project.images.filter((x) => x.id !== imageId);
    if (selectedImageId === imageId) selectedImageId = null;
    renderImageOverlays();
    try {
      await Api.del(`/api/projects/${PROJECT_ID}/images/${imageId}`);
    } catch (err) {
      console.error(err);
    }
  });
}

function bindImageRowEvents() {
  document.getElementById("img-start").addEventListener("change", () => {
    const im = project.images.find((x) => x.id === selectedImageId);
    if (!im) return;
    pushUndo();
    im.start = parseTime(document.getElementById("img-start").value);
    saveProjectPatch({ images: project.images });
  });
  document.getElementById("img-end").addEventListener("change", () => {
    const im = project.images.find((x) => x.id === selectedImageId);
    if (!im) return;
    pushUndo();
    const v = document.getElementById("img-end").value.trim();
    im.end = v === "" ? null : parseTime(v);
    saveProjectPatch({ images: project.images });
  });
  document.getElementById("img-delete-btn").addEventListener("click", async () => {
    const im = project.images.find((x) => x.id === selectedImageId);
    if (!im) return;
    pushUndo();
    project.images = project.images.filter((x) => x.id !== im.id);
    selectedImageId = null;
    renderImageOverlays();
    try {
      await Api.del(`/api/projects/${PROJECT_ID}/images/${im.id}`);
    } catch (err) {
      console.error(err);
    }
  });
}

function updateImageRow() {
  const row = document.getElementById("image-row");
  const im = project.images.find((x) => x.id === selectedImageId);
  if (!im) {
    row.style.display = "none";
    return;
  }
  row.style.display = "flex";
  document.getElementById("img-start").value = fmtTime(im.start);
  document.getElementById("img-end").value = im.end != null ? fmtTime(im.end) : "";
}

// I2-5: banner + retry button when translation didn't fully succeed.
function setupTranslationBanner() {
  updateTranslationBanner();
  document.getElementById("retry-translation-btn").addEventListener("click", async () => {
    if (!confirm("Retrying replaces all current lines, including any manual edits. Continue?")) return;
    const progress = document.getElementById("retry-progress");
    progress.style.display = "block";
    try {
      const { job_id } = await Api.post(`/api/projects/${PROJECT_ID}/retranslate`, {});
      await pollJob(job_id, (job) => {
        document.getElementById("retry-msg").textContent = job.message || "Working…";
        const pct = Math.round((job.progress || 0) * 100);
        document.getElementById("retry-pct").textContent = pct + "%";
        document.getElementById("retry-fill").style.width = pct + "%";
      });
      location.reload();
    } catch (e) {
      document.getElementById("translation-err-text").textContent = String(e.message || e);
      progress.style.display = "none";
    }
  });
}

function updateTranslationBanner() {
  const banner = document.getElementById("translation-err-banner");
  if (project.translation_status && project.translation_status !== "ok") {
    document.getElementById("translation-err-text").textContent =
      `Translation incomplete: ${project.translation_error || "unknown error"}. Fix your API settings, then retry.`;
    banner.style.display = "block";
  } else {
    banner.style.display = "none";
  }
}

// I2-10: effective per-line style, falling back to the project style field
// by field (a per-line override may set only some fields).
function effectiveStyle(line) {
  const s = project.style;
  const ov = line && line.style;
  return {
    font: (ov && ov.font) || s.font,
    size: ov && ov.size != null ? ov.size : s.size,
    color: (ov && ov.color) || s.color,
    outline_color: (ov && ov.outline_color) || s.outline_color,
    outline_width: s.outline_width,
    position: (ov && ov.position) || s.position,
    pos_x: ov && ov.pos_x != null ? ov.pos_x : s.pos_x,
    pos_y: ov && ov.pos_y != null ? ov.pos_y : s.pos_y,
  };
}

// I2-13: builds the stacked stroke+fill markup for one text line, using the
// duplicated-layer technique instead of a 4-direction text-shadow (which
// leaves gaps at diagonal glyph edges). Stroke width is 2x the configured
// outline width because -webkit-text-stroke is centered on the glyph edge —
// the front fill layer covers the inner half, leaving the outer half as the
// visible outline.
function strokeFillSpan(cls, text, fontpx, color, outlinePx, outlineColor, fontFamily) {
  const strokeW = Math.max(0, outlinePx * 2);
  const fontStyle = fontFamily ? `font-family:'${escapeHtml(fontFamily)}';` : "";
  return (
    `<span class="sub-line ${cls}" style="font-size:${fontpx}px; ${fontStyle}">` +
    `<span class="stroke" aria-hidden="true" style="-webkit-text-stroke:${strokeW}px ${outlineColor}; color:${outlineColor};">${escapeHtml(text)}</span>` +
    `<span class="fill" style="color:${color};">${escapeHtml(text)}</span>` +
    `</span>`
  );
}

function updateOverlay() {
  if (!edVideoEl) return;
  if (overlayDragging) return; // I2-13: the drag handler owns position + content until pointerup
  const t = edVideoEl.currentTime;
  const overlay = document.getElementById("sub-overlay");
  if (!overlay) return;
  const line = project.lines.find((l) => t >= l.start && t < l.end);

  if (!line) {
    if (lastOverlayRenderKey === null) return; // already empty — nothing to do
    lastOverlayRenderKey = null;
    overlay.style.left = "";
    overlay.style.bottom = "";
    overlay.style.transform = "";
    overlay.innerHTML = "";
    overlay.classList.remove("top", "custom-pos", "has-line");
    delete overlay.dataset.lineId;
    return;
  }

  const eff = effectiveStyle(line);
  const key = JSON.stringify([line.id, line.text_tgt, line.text_src, project.style.bilingual, eff]);
  if (key === lastOverlayRenderKey) return; // I2-13: identical to what's already on screen — skip the DOM write
  lastOverlayRenderKey = key;

  overlay.dataset.lineId = line.id;
  overlay.classList.add("has-line");

  const videoH = edVideoEl.clientHeight || 300;
  const fontpx = Math.round((eff.size * videoH) / 1080);
  const outlinePx = Math.max(0, Math.round((eff.outline_width * videoH) / 1080));

  let html = strokeFillSpan("zh", line.text_tgt, fontpx, eff.color, outlinePx, eff.outline_color, eff.font);
  if (project.style.bilingual) {
    // ja row keeps its own muted tone (matches the pre-existing look) rather
    // than the (possibly per-line-overridden) target-text color.
    html += strokeFillSpan("ja", line.text_src, Math.round(fontpx * 0.6), "#E8D9C4", outlinePx, eff.outline_color);
  }
  overlay.innerHTML = html;

  overlay.style.left = "";
  overlay.style.bottom = "";
  overlay.style.transform = "";
  if (eff.pos_x != null && eff.pos_y != null) {
    overlay.classList.remove("top");
    overlay.classList.add("custom-pos");
    overlay.style.left = `${eff.pos_x * 100}%`;
    overlay.style.bottom = `${(1 - eff.pos_y) * 100}%`;
    overlay.style.transform = "translateX(-50%)";
  } else {
    overlay.classList.remove("custom-pos");
    overlay.classList.toggle("top", eff.position === "top");
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderLinesTable() {
  document.getElementById("col-tgt").textContent = `Translation`;
  document.getElementById("col-src").textContent = `Original`;
  const table = document.getElementById("lines-table");
  table.querySelectorAll("tr:not(:first-child)").forEach((r) => r.remove());
  project.lines.forEach((line, i) => {
    const dur = Math.max(0.001, line.end - line.start);
    const cps = (line.text_tgt || "").length / dur;
    const tr = document.createElement("tr");
    tr.dataset.id = line.id;
    tr.className = line.id === selectedLineId ? "active" : "";
    tr.innerHTML = `
      <td class="mono">${i + 1}</td>
      <td class="mono">${fmtTime(line.start)}</td>
      <td class="mono">${fmtTime(line.end)}</td>
      <td class="mono ${cps > 15 ? "cps-bad" : ""}">${cps.toFixed(1)}</td>
      <td>${escapeHtml(line.text_tgt)}</td>
      <td class="src">${escapeHtml(line.text_src)}</td>`;
    tr.addEventListener("click", () => selectLine(line.id));
    table.appendChild(tr);
  });
}

function selectLine(id) {
  selectedLineId = id;
  const line = project.lines.find((l) => l.id === id);
  if (!line) return;
  fillInspector(line);
  document.querySelectorAll("#lines-table tr").forEach((tr) => tr.classList.toggle("active", tr.dataset.id === id));

  edRegionsPlugin.getRegions().forEach((r) => r.remove());
  edRegionsPlugin.addRegion({ start: line.start, end: line.end, color: "rgba(53,217,192,0.3)", content: `Line ${project.lines.indexOf(line) + 1}`, drag: true, resize: true });
  const dur = edWs.getDuration() || project.video_duration;
  if (dur) {
    const target = Math.max(0, line.start - 2);
    edWs.seekTo(Math.min(1, target / dur));
  }
  edVideoEl.currentTime = line.start;

  const rowEl = document.querySelector(`#lines-table tr[data-id="${id}"]`);
  if (rowEl) rowEl.scrollIntoView({ block: "nearest" });
}

function fillInspector(line) {
  document.getElementById("ed-start").value = fmtTime(line.start);
  document.getElementById("ed-end").value = fmtTime(line.end);
  document.getElementById("ed-text-tgt").value = line.text_tgt;
  document.getElementById("ed-text-src").value = line.text_src;

  const ov = line.style || {};
  document.getElementById("ov-font").value = ov.font || "";
  document.getElementById("ov-size").value = ov.size != null ? ov.size : "";
  document.getElementById("ov-color").value = ov.color || project.style.color;
  document.getElementById("ov-outline-color").value = ov.outline_color || project.style.outline_color;
  document.getElementById("ov-position").value = ov.position || "";
}

// I2-9: re-render the line-dependent UI (table/inspector/region) without
// seeking the video — used after undo/redo so playback position is left
// alone.
function refreshLineUI() {
  renderLinesTable();
  const line = currentLine();
  if (line && edRegionsPlugin) {
    fillInspector(line);
    selectRowOnly(line.id);
    edRegionsPlugin.getRegions().forEach((r) => r.remove());
    edRegionsPlugin.addRegion({
      start: line.start,
      end: line.end,
      color: "rgba(53,217,192,0.3)",
      content: `Line ${project.lines.indexOf(line) + 1}`,
      drag: true,
      resize: true,
    });
  } else if (edRegionsPlugin) {
    edRegionsPlugin.getRegions().forEach((r) => r.remove());
  }
}

function bindInspectorEvents() {
  const startEl = document.getElementById("ed-start");
  const endEl = document.getElementById("ed-end");
  const tgtEl = document.getElementById("ed-text-tgt");
  const srcEl = document.getElementById("ed-text-src");

  const commitTime = () => {
    const line = currentLine();
    if (!line) return;
    pushUndo();
    line.start = parseTime(startEl.value);
    line.end = parseTime(endEl.value);
    renderLinesTable();
    selectRowOnly(line.id);
    updateOverlay();
    scheduleAutosave();
  };
  startEl.addEventListener("change", commitTime);
  endEl.addEventListener("change", commitTime);

  // I2-9: text areas fire "input" per keystroke — push one undo snapshot per
  // edit session (first keystroke after focus), not per keystroke.
  let tgtPushed = false;
  let srcPushed = false;
  tgtEl.addEventListener("focus", () => (tgtPushed = false));
  srcEl.addEventListener("focus", () => (srcPushed = false));

  tgtEl.addEventListener("input", () => {
    const line = currentLine();
    if (!line) return;
    if (!tgtPushed) {
      pushUndo();
      tgtPushed = true;
    }
    line.text_tgt = tgtEl.value;
    renderLinesTable();
    selectRowOnly(line.id);
    updateOverlay();
    scheduleAutosave();
  });
  srcEl.addEventListener("input", () => {
    const line = currentLine();
    if (!line) return;
    if (!srcPushed) {
      pushUndo();
      srcPushed = true;
    }
    line.text_src = srcEl.value;
    renderLinesTable();
    selectRowOnly(line.id);
    updateOverlay();
    scheduleAutosave();
  });
}

function selectRowOnly(id) {
  document.querySelectorAll("#lines-table tr").forEach((tr) => tr.classList.toggle("active", tr.dataset.id === id));
}

function currentLine() {
  return project.lines.find((l) => l.id === selectedLineId);
}

function scheduleAutosave() {
  const lab = document.getElementById("autosave-lab");
  lab.textContent = "Saving…";
  lab.classList.add("saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await Api.put(`/api/projects/${PROJECT_ID}/lines`, { lines: project.lines });
      lab.textContent = "Saved ✓";
      lab.classList.remove("saving");
    } catch (e) {
      lab.textContent = "Save failed";
    }
  }, 800);
}

function scheduleStyleSave() {
  clearTimeout(styleSaveTimer);
  styleSaveTimer = setTimeout(() => {
    saveProjectPatch({ style: project.style });
  }, 500);
}

// --- line ops ---
function splitAtPlayhead() {
  const line = currentLine();
  if (!line) return;
  const t = edVideoEl.currentTime;
  if (t <= line.start || t >= line.end) return;
  pushUndo();
  const frac = (t - line.start) / (line.end - line.start);
  const splitIdx = Math.max(1, Math.round(line.text_tgt.length * frac));
  const newLine = {
    id: crypto.randomUUID().slice(0, 8),
    start: t,
    end: line.end,
    text_tgt: line.text_tgt.slice(splitIdx),
    text_src: "",
    style: null,
  };
  line.end = t;
  line.text_tgt = line.text_tgt.slice(0, splitIdx);
  const idx = project.lines.indexOf(line);
  project.lines.splice(idx + 1, 0, newLine);
  renderLinesTable();
  scheduleAutosave();
}

function mergeWithNext() {
  const line = currentLine();
  if (!line) return;
  const idx = project.lines.indexOf(line);
  const next = project.lines[idx + 1];
  if (!next) return;
  pushUndo();
  line.end = next.end;
  line.text_tgt = (line.text_tgt + " " + next.text_tgt).trim();
  line.text_src = (line.text_src + " " + next.text_src).trim();
  project.lines.splice(idx + 1, 1);
  renderLinesTable();
  selectLine(line.id);
  scheduleAutosave();
}

// I2-12: "N" / "+ New line at playhead" — creates a blank 1.5s line at the
// playhead (or right after the covering line if the playhead already sits
// inside one), clamped so it never overlaps the next line's start. Works
// with zero existing lines (does not rely on currentLine()/selection).
function createNewLineAtPlayhead() {
  if (!edVideoEl) return;
  const t = edVideoEl.currentTime;
  const covering = project.lines.find((l) => t >= l.start && t < l.end);
  const start = covering ? covering.end : t;
  const next = project.lines
    .filter((l) => l.start > start)
    .sort((a, b) => a.start - b.start)[0];
  let end = start + 1.5;
  if (next && end > next.start) end = next.start;
  if (end <= start) end = start + 0.05; // squeezed extremely tight — still a valid (tiny) line

  pushUndo();
  const newLine = { id: crypto.randomUUID().slice(0, 8), start, end, text_tgt: "", text_src: "", style: null };
  let idx = project.lines.findIndex((l) => l.start > start);
  if (idx === -1) idx = project.lines.length;
  project.lines.splice(idx, 0, newLine);
  renderLinesTable();
  selectLine(newLine.id);
  scheduleAutosave();
  const tgtEl = document.getElementById("ed-text-tgt");
  if (tgtEl) tgtEl.focus();
}

function insertAfter() {
  const line = currentLine();
  if (!line) return;
  pushUndo();
  const idx = project.lines.indexOf(line);
  const newLine = { id: crypto.randomUUID().slice(0, 8), start: line.end, end: line.end + 1.5, text_tgt: "", text_src: "", style: null };
  project.lines.splice(idx + 1, 0, newLine);
  renderLinesTable();
  selectLine(newLine.id);
  scheduleAutosave();
}

function deleteSelected() {
  const line = currentLine();
  if (!line) return;
  pushUndo();
  const idx = project.lines.indexOf(line);
  project.lines.splice(idx, 1);
  renderLinesTable();
  if (project.lines[idx]) selectLine(project.lines[idx].id);
  else if (project.lines[idx - 1]) selectLine(project.lines[idx - 1].id);
  scheduleAutosave();
}

function nextLine() {
  const idx = project.lines.findIndex((l) => l.id === selectedLineId);
  if (idx >= 0 && idx + 1 < project.lines.length) selectLine(project.lines[idx + 1].id);
}
function prevLine() {
  const idx = project.lines.findIndex((l) => l.id === selectedLineId);
  if (idx > 0) selectLine(project.lines[idx - 1].id);
}

// ====================================================== 03 EXPORT TAB ===
let mp4Track = "translation", mp4Scope = "full";
let subKind = "srt", subTrack = "translation", subScope = "full";

function setupExportTab() {
  bindOptGroup("mp4-track-opts", "track", (v) => (mp4Track = v));
  bindOptGroup("mp4-scope-opts", "scope", (v) => (mp4Scope = v));
  bindOptGroup("sub-kind-opts", "kind", (v) => (subKind = v));
  bindOptGroup("sub-track-opts", "track", (v) => (subTrack = v));
  bindOptGroup("sub-scope-opts", "scope", (v) => (subScope = v));

  document.getElementById("export-mp4-btn").addEventListener("click", () => doExport("mp4", mp4Track, mp4Scope));
  document.getElementById("export-sub-btn").addEventListener("click", () => doExport(subKind, subTrack, subScope));
}

function bindOptGroup(containerId, dataAttr, onChange) {
  const container = document.getElementById(containerId);
  container.querySelectorAll(".opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".opt").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      onChange(btn.dataset[dataAttr]);
    });
  });
}

async function doExport(kind, track, scope) {
  document.getElementById("export-err").style.display = "none";
  document.getElementById("export-result").textContent = "";
  document.getElementById("export-progress").style.display = "block";
  const outputDir = document.getElementById("output-dir").value.trim();
  try {
    const { job_id } = await Api.post(`/api/projects/${PROJECT_ID}/export`, { kind, track, scope, output_dir: outputDir || undefined });
    const job = await pollJob(job_id, (j) => {
      document.getElementById("export-msg").textContent = j.message || "Working…";
      const pct = Math.round((j.progress || 0) * 100);
      document.getElementById("export-pct").textContent = pct + "%";
      document.getElementById("export-fill").style.width = pct + "%";
    });
    const paths = job.result.output_paths || [job.result.output_path];
    document.getElementById("export-result").textContent = "Exported:\n" + paths.join("\n");
  } catch (e) {
    document.getElementById("export-err").textContent = String(e.message || e);
    document.getElementById("export-err").style.display = "block";
  }
}

// ================================================== keyboard handling ===
function onGlobalKeydown(e) {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

  if (currentTab === "clips") return onClipsKeydown(e);
  if (currentTab === "editor") return onEditorKeydown(e);
}

function onClipsKeydown(e) {
  if (!videoEl) return;
  switch (e.key.toLowerCase()) {
    case " ":
      e.preventDefault();
      videoEl.paused ? videoEl.play() : videoEl.pause();
      break;
    case "i":
      setPendingIn(videoEl.currentTime);
      break;
    case "o":
      if (pendingIn !== null) {
        const start = Math.min(pendingIn, videoEl.currentTime);
        const end = Math.max(pendingIn, videoEl.currentTime);
        cancelPendingIn();
        if (end > start) addClipRegion(start, end);
      }
      break;
    case "escape":
      cancelPendingIn();
      break;
    case "arrowleft":
      e.preventDefault();
      panByViewport(ws, "#track", -0.25);
      break;
    case "arrowright":
      e.preventDefault();
      panByViewport(ws, "#track", 0.25);
      break;
    case "j":
      videoEl.currentTime = Math.max(0, videoEl.currentTime - 5);
      break;
    case "l":
      videoEl.currentTime = Math.min(project.video_duration, videoEl.currentTime + 5);
      break;
    case "q":
      playWindow(videoEl, Math.max(0, videoEl.currentTime - 3), videoEl.currentTime);
      break;
    case "w":
      playWindow(videoEl, videoEl.currentTime, Math.min(project.video_duration, videoEl.currentTime + 3));
      break;
  }
}

function onEditorKeydown(e) {
  if (!edVideoEl) return;
  const line = currentLine();

  // I2-9: Ctrl+Z undo, Ctrl+Y or Ctrl+Shift+Z redo. Inputs/textareas already
  // bail out of onGlobalKeydown before reaching here, so they keep native
  // undo — this only fires when the grid/waveform/video area has focus.
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    doRedo();
    return;
  }

  switch (e.key) {
    case " ":
      e.preventDefault();
      edVideoEl.paused ? edVideoEl.play() : edVideoEl.pause();
      break;
    case "n":
    case "N":
      e.preventDefault();
      createNewLineAtPlayhead();
      break;
    case "[":
      if (line) {
        pushUndo();
        line.start = edVideoEl.currentTime;
        fillInspector(line);
        renderLinesTable();
        selectRowOnly(line.id);
        scheduleAutosave();
      }
      break;
    case "]":
      if (line) {
        pushUndo();
        line.end = edVideoEl.currentTime;
        fillInspector(line);
        renderLinesTable();
        selectRowOnly(line.id);
        scheduleAutosave();
      }
      break;
    case "Enter":
      e.preventDefault();
      nextLine();
      break;
    case "q":
    case "Q":
      if (line) playWindow(edVideoEl, Math.max(0, line.start - 3), line.start);
      break;
    case "w":
    case "W":
      if (line) playWindow(edVideoEl, line.start, line.end);
      break;
    case "r":
    case "R":
      if (line) playWindow(edVideoEl, line.start, line.end);
      break;
    case "ArrowUp":
      e.preventDefault();
      prevLine();
      break;
    case "ArrowDown":
      e.preventDefault();
      nextLine();
      break;
    case "ArrowLeft":
      e.preventDefault();
      panByViewport(edWs, "#ed-track", -0.25);
      break;
    case "ArrowRight":
      e.preventDefault();
      panByViewport(edWs, "#ed-track", 0.25);
      break;
    case "+":
    case "=":
      e.preventDefault();
      zoomLevels.editor = Math.max(10, Math.min(500, zoomLevels.editor * 1.3));
      try {
        edWs.zoom(zoomLevels.editor);
      } catch (err) {
        // not ready yet — ignore
      }
      updateZoomReadout("editor");
      break;
    case "-":
    case "_":
      e.preventDefault();
      zoomLevels.editor = Math.max(10, Math.min(500, zoomLevels.editor / 1.3));
      try {
        edWs.zoom(zoomLevels.editor);
      } catch (err) {
        // not ready yet — ignore
      }
      updateZoomReadout("editor");
      break;
  }
}

function updateZoomReadout(kind) {
  const readout = document.getElementById(`${kind}-zoom-readout`);
  if (readout) readout.textContent = `${Math.round(zoomLevels[kind])} px/s`;
}

function playWindow(video, start, end) {
  video.currentTime = start;
  video.play();
  const stopAt = () => {
    if (video.currentTime >= end) {
      video.pause();
      video.removeEventListener("timeupdate", stopAt);
    }
  };
  video.addEventListener("timeupdate", stopAt);
}
