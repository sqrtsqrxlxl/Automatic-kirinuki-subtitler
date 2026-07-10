from __future__ import annotations

import threading
import traceback
import uuid
from typing import Callable

from pydantic import BaseModel


class Job(BaseModel):
    id: str
    kind: str  # "import" | "pipeline" | "export"
    project_id: str | None = None
    status: str = "running"  # "running" | "done" | "error"
    progress: float = 0.0
    message: str = ""
    result: dict | None = None
    error: str | None = None


_JOBS: dict[str, Job] = {}
_LOCK = threading.Lock()


def get_job(job_id: str) -> Job | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        return job.model_copy() if job else None


def _update(job_id: str, **fields) -> None:
    with _LOCK:
        job = _JOBS[job_id]
        for k, v in fields.items():
            setattr(job, k, v)


def start_job(kind: str, target: Callable[[Callable[[float, str], None]], dict | None], project_id: str | None = None) -> str:
    job_id = uuid.uuid4().hex[:10]
    job = Job(id=job_id, kind=kind, project_id=project_id)
    with _LOCK:
        _JOBS[job_id] = job

    def report(progress: float, message: str) -> None:
        _update(job_id, progress=max(0.0, min(1.0, progress)), message=message)

    def run():
        try:
            result = target(report)
            _update(job_id, status="done", progress=1.0, result=result or {})
        except Exception as e:  # noqa: BLE001
            tb = traceback.format_exc()
            _update(job_id, status="error", error=f"{e}\n{tb[-2000:]}")

    threading.Thread(target=run, daemon=True).start()
    return job_id
