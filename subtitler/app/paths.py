from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECTS_DIR = ROOT / "projects"
SETTINGS_PATH = ROOT / "settings.json"
STATIC_DIR = ROOT / "static"

PROJECTS_DIR.mkdir(exist_ok=True)


def project_dir(project_id: str) -> Path:
    d = PROJECTS_DIR / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d
