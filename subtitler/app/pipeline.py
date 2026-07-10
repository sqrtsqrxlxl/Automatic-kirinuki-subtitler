"""Pipeline dispatch seam (BUILD_MANUAL.md §5.3). Only 'two_stage' exists today;
the registry lets a future whole-pipeline alternative (e.g. multimodal
audio-in/lines-out) plug in without touching the editor or exporter, which
only ever read project.lines."""
from __future__ import annotations

import json
from typing import Callable, Protocol

from . import logger, projects, settings_store, transcribe, translate
from .models import Line, Word
from .paths import project_dir

Report = Callable[[float, str], None]


class SubtitlePipeline(Protocol):
    def run(self, project_id: str, report: Report) -> list[Line]: ...


class TwoStagePipeline:
    def run(self, project_id: str, report: Report) -> list[Line]:
        project = projects.load_project(project_id)
        settings = settings_store.load_settings()

        # I2-5: fail fast on a bad LLM key/base-url BEFORE burning whisper
        # time on transcription.
        report(0.0, "Checking LLM connection…")
        ok, message = translate.test_llm_connection(settings)
        if not ok:
            logger.log(project_id, "error", f"pipeline: LLM connection check failed: {message}")
            raise ValueError(f"LLM connection failed before starting: {message} — fix Settings (⚙) and start again.")
        logger.log(project_id, "info", "pipeline: LLM connection check ok")

        project.status = "transcribing"
        projects.save_project(project)

        def report_transcribe(frac, msg):
            report(frac * 0.5, msg)

        words = transcribe.transcribe_project(project_id, project, settings, report_transcribe)

        project = projects.load_project(project_id)
        project.status = "translating"
        projects.save_project(project)

        def report_translate(frac, msg):
            report(0.5 + frac * 0.5, msg)

        lines, tstatus, terror = translate.segment_and_translate(project_id, words, project, settings, report_translate)

        project = projects.load_project(project_id)
        project.lines = lines
        project.translation_status = tstatus
        project.translation_error = terror
        project.status = "ready"
        projects.save_project(project)
        logger.log(project_id, "info", f"pipeline: done, {len(lines)} lines, translation_status={tstatus}")
        return lines


PIPELINES: dict[str, type] = {"two_stage": TwoStagePipeline}


def run_pipeline(project_id: str, report: Report) -> dict:
    settings = settings_store.load_settings()
    pipeline_cls = PIPELINES.get(settings.pipeline, TwoStagePipeline)
    pipeline_cls().run(project_id, report)
    return {"project_id": project_id}


def run_retranslate(project_id: str, report: Report) -> dict:
    words_path = project_dir(project_id) / "words.json"
    if not words_path.exists():
        raise ValueError("No transcription found for this project — run the full pipeline first.")
    words = [Word.model_validate(w) for w in json.loads(words_path.read_text(encoding="utf-8"))]

    project = projects.load_project(project_id)
    settings = settings_store.load_settings()
    project.status = "translating"
    projects.save_project(project)

    lines, tstatus, terror = translate.segment_and_translate(project_id, words, project, settings, report)

    project = projects.load_project(project_id)
    project.lines = lines
    project.translation_status = tstatus
    project.translation_error = terror
    project.status = "ready"
    projects.save_project(project)
    logger.log(project_id, "info", f"retranslate: done, {len(lines)} lines, translation_status={tstatus}")
    return {"project_id": project_id}
