"""Per-project debug log — feeds the Debug tab console in the UI (mirrors log.txt)."""
from __future__ import annotations

import threading
import time

from .paths import project_dir

_lock = threading.Lock()


def _log_path(project_id: str):
    return project_dir(project_id) / "log.txt"


def log(project_id: str, level: str, message: str) -> None:
    ts = time.strftime("%H:%M:%S", time.localtime()) + f".{int(time.time() * 1000) % 1000:03d}"
    line = f"{ts} {level.upper():5s} {message}"
    with _lock:
        with open(_log_path(project_id), "a", encoding="utf-8") as f:
            f.write(line + "\n")


def read_log(project_id: str, tail: int = 500) -> str:
    p = _log_path(project_id)
    if not p.exists():
        return ""
    lines = p.read_text(encoding="utf-8").splitlines()
    return "\n".join(lines[-tail:])
