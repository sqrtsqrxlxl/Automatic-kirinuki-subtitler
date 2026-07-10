async function loadRecent() {
  const list = document.getElementById("recent-list");
  const projects = await Api.get("/api/projects");
  if (!projects.length) {
    list.innerHTML = `<p style="color: var(--ink-2); font-size: 13px;">No projects yet.</p>`;
    return;
  }
  list.innerHTML = projects
    .map(
      (p) => `<div class="recent-item" data-id="${p.id}">
        <span>${p.video_filename || p.id}</span>
        <span class="rstatus">${p.status}</span>
        <button class="style-chip" data-del="${p.id}">Delete</button>
      </div>`
    )
    .join("");
  list.querySelectorAll(".recent-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-del]")) return;
      const id = el.dataset.id;
      const status = projects.find((p) => p.id === id).status;
      const tab = status === "ready" ? "editor" : "clips";
      window.location.href = `/static/workspace.html?project=${id}&tab=${tab}`;
    });
  });
  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      if (!confirm(`Delete project "${id}"? This removes its whole folder and cannot be undone.`)) return;
      try {
        await Api.del(`/api/projects/${id}`);
      } catch (err) {
        alert(String(err.message || err));
      }
      loadRecent();
    });
  });
}

async function startImport() {
  const input = document.getElementById("video-path");
  const path = input.value.trim();
  const errEl = document.getElementById("import-err");
  errEl.style.display = "none";
  if (!path) return;

  document.getElementById("load-btn").disabled = true;
  document.getElementById("import-progress").style.display = "block";

  try {
    const { project_id, job_id } = await Api.post("/api/projects", { video_path: path });
    // Don't wait for the import job here — jump straight into the workspace and
    // show progress there (I2-1). Re-enable the button in case navigation is
    // ever aborted by the browser.
    window.location.href = `/static/workspace.html?project=${project_id}&tab=clips&import_job=${job_id}`;
  } catch (e) {
    errEl.textContent = String(e.message || e);
    errEl.style.display = "block";
  } finally {
    document.getElementById("load-btn").disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("load-btn").addEventListener("click", startImport);
  document.getElementById("video-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") startImport();
  });
  loadRecent();
});
