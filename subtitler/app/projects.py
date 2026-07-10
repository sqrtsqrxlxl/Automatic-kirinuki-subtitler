from __future__ import annotations

import threading

from .models import Project
from .paths import PROJECTS_DIR, project_dir

_lock = threading.Lock()


def _project_json_path(project_id: str):
    return project_dir(project_id) / "project.json"


def load_project(project_id: str) -> Project:
    p = _project_json_path(project_id)
    if not p.exists():
        raise FileNotFoundError(f"No project '{project_id}'")
    return Project.model_validate_json(p.read_text(encoding="utf-8"))


def save_project(project: Project) -> None:
    with _lock:
        _project_json_path(project.id).write_text(
            project.model_dump_json(indent=2), encoding="utf-8"
        )


def list_projects() -> list[dict]:
    out = []
    if not PROJECTS_DIR.exists():
        return out
    for d in sorted(PROJECTS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        pj = d / "project.json"
        if pj.exists():
            try:
                proj = Project.model_validate_json(pj.read_text(encoding="utf-8"))
                out.append(
                    {
                        "id": proj.id,
                        "video_filename": proj.video_filename,
                        "status": proj.status,
                        "duration": proj.video_duration,
                    }
                )
            except Exception:
                continue
    return out
