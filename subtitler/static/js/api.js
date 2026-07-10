const Api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  async patch(url, body) {
    const r = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: "DELETE" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
};

function fmtTime(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  return `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function parseTime(str) {
  str = String(str).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(":");
  let sec = 0;
  for (const p of parts) sec = sec * 60 + parseFloat(p || 0);
  return sec;
}

async function pollJob(jobId, onProgress) {
  while (true) {
    const job = await Api.get(`/api/jobs/${jobId}`);
    onProgress(job);
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error || "Job failed");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function levelClass(line) {
  if (/\bERROR\b/.test(line)) return "lv-error";
  if (/\bWARN\b/.test(line)) return "lv-warn";
  return "lv-info";
}

async function refreshDebugConsole(projectId, bodyEl) {
  if (!projectId) return;
  try {
    const { log } = await Api.get(`/api/projects/${projectId}/log`);
    bodyEl.innerHTML = log
      .split("\n")
      .filter(Boolean)
      .map((l) => `<div class="${levelClass(l)}">${l.replace(/</g, "&lt;")}</div>`)
      .join("");
    bodyEl.scrollTop = bodyEl.scrollHeight;
  } catch (e) {
    // no log yet
  }
}

function setupDebugTab(root, projectId) {
  const tab = root.querySelector(".tab.dbg");
  const panels = root.querySelectorAll("[data-panel]");
  const dbgPanel = root.querySelector('[data-panel="debug"]');
  if (!tab || !dbgPanel) return;
  const consoleBody = dbgPanel.querySelector(".c-body");
  let interval = null;

  tab.addEventListener("click", () => {
    root.querySelectorAll(".tab").forEach((t) => t.classList.remove("on"));
    tab.classList.add("on");
    panels.forEach((p) => (p.style.display = "none"));
    dbgPanel.style.display = "block";
    refreshDebugConsole(projectId, consoleBody);
    if (!interval) interval = setInterval(() => refreshDebugConsole(projectId, consoleBody), 2000);
  });

  const copyBtn = dbgPanel.querySelector(".copy-log-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(consoleBody.innerText);
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => (copyBtn.textContent = "Copy for Claude ⧉"), 1500);
    });
  }

  return { showTab: (name) => {
    root.querySelectorAll(".tab").forEach((t) => t.classList.remove("on"));
    root.querySelector(`.tab[data-tab="${name}"]`)?.classList.add("on");
    panels.forEach((p) => (p.style.display = p.dataset.panel === name ? "block" : "none"));
    if (name === "debug") {
      refreshDebugConsole(projectId, consoleBody);
      if (!interval) interval = setInterval(() => refreshDebugConsole(projectId, consoleBody), 2000);
    }
  }};
}
