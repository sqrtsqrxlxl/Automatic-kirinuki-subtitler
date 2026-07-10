from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Callable, Protocol

from . import logger
from .models import Word
from .paths import project_dir

_MODEL_CACHE: dict[tuple, object] = {}
_CACHE_LOCK = threading.Lock()

KOTOBA_MODEL = "kotoba-tech/kotoba-whisper-v2.0-faster"

Report = Callable[[float, str], None]


class Transcriber(Protocol):
    def transcribe(self, audio_path: str, lang: str | None, report: Report) -> list[Word]: ...


class FasterWhisperTranscriber:
    def __init__(self, settings):
        from faster_whisper import WhisperModel

        key = ("faster-whisper", settings.whisper_model, settings.whisper_device, settings.whisper_compute_type)
        with _CACHE_LOCK:
            if key not in _MODEL_CACHE:
                _MODEL_CACHE[key] = WhisperModel(
                    settings.whisper_model,
                    device=settings.whisper_device,
                    compute_type=settings.whisper_compute_type,
                )
            self.model = _MODEL_CACHE[key]

    def transcribe(self, audio_path: str, lang: str | None, report: Report) -> list[Word]:
        segments, info = self.model.transcribe(
            audio_path,
            language=lang or None,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        words: list[Word] = []
        total = getattr(info, "duration", 0) or 0
        for seg in segments:
            for w in (seg.words or []):
                words.append(Word(start=w.start, end=w.end, text=w.word))
            if total:
                report(min(0.98, seg.end / total), f"Transcribing… {seg.end:.0f}s / {total:.0f}s")
        return words


class StableTsTranscriber:
    def __init__(self, settings):
        import stable_whisper

        key = ("stable-ts", settings.whisper_model, settings.whisper_device, settings.whisper_compute_type)
        with _CACHE_LOCK:
            if key not in _MODEL_CACHE:
                try:
                    _MODEL_CACHE[key] = stable_whisper.load_faster_whisper(
                        settings.whisper_model,
                        device=settings.whisper_device,
                        compute_type=settings.whisper_compute_type,
                    )
                except Exception as e:  # noqa: BLE001
                    # I2-4: kotoba (and any other model) may fail to load through
                    # stable-ts's wrapper even though plain faster-whisper handles it.
                    raise RuntimeError(
                        f"stable-ts could not load {settings.whisper_model}: {e!r} — "
                        "try the faster-whisper engine for this model."
                    ) from e
            self.model = _MODEL_CACHE[key]

    def transcribe(self, audio_path: str, lang: str | None, report: Report) -> list[Word]:
        report(0.5, "Transcribing (stable-ts)…")
        # I2-4: in stable-ts 2.19, load_faster_whisper() does NOT replace
        # .transcribe() — the patched, silence-aware method is
        # .transcribe_stable() (name varies by version). Calling the plain
        # .transcribe(vad=True) hits the ORIGINAL faster-whisper method, which
        # has no `vad` kwarg -> TypeError. Prefer transcribe_stable() when
        # present, and drop stable-ts-only kwargs if the resolved method
        # doesn't accept them.
        fn = getattr(self.model, "transcribe_stable", None) or self.model.transcribe
        try:
            result = fn(audio_path, language=lang or None, word_timestamps=True, vad=True)
        except TypeError:
            result = fn(audio_path, language=lang or None, word_timestamps=True)
        words: list[Word] = []
        for seg in result.segments:
            for w in seg.words:
                words.append(Word(start=w.start, end=w.end, text=w.word))
        report(1.0, "Transcription complete")
        return words


def get_transcriber(settings) -> Transcriber:
    if settings.asr_engine == "stable-ts":
        return StableTsTranscriber(settings)
    return FasterWhisperTranscriber(settings)


def transcribe_project(project_id: str, project, settings, report: Report) -> list[Word]:
    """Handles the whole-video vs clip-mode split and saves words.json."""
    if settings.whisper_model == KOTOBA_MODEL and project.source_lang != "ja":
        raise ValueError(
            "kotoba-whisper only supports Japanese — switch model or set source language to ja."
        )

    logger.log(project_id, "info", f"whisper: loading {settings.whisper_model} ({settings.asr_engine})")
    report(0.0, "Downloading/loading ASR model…")
    try:
        transcriber = get_transcriber(settings)
    except Exception as e:  # noqa: BLE001
        # I2-4: the user must be able to open the Debug tab and read exactly
        # what failed, including which engine+model were involved.
        logger.log(
            project_id,
            "error",
            f"transcribe: failed to load engine={settings.asr_engine} model={settings.whisper_model}: {e!r}",
        )
        raise

    pdir = project_dir(project_id)
    audio_path = pdir / "audio.wav"

    try:
        if not project.clips:
            logger.log(project_id, "info", "whisper: transcribing whole video")
            words = transcriber.transcribe(str(audio_path), project.source_lang, report)
        else:
            words = []
            n = len(project.clips)
            for i, clip in enumerate(project.clips):
                tmp_wav = pdir / f"_clip{i}.wav"
                from . import ffmpeg_utils

                ffmpeg_utils.run_ffmpeg(
                    ["-ss", str(clip.start), "-to", str(clip.end), "-i", str(audio_path), "-c", "copy", str(tmp_wav)]
                )

                def clip_report(frac, msg, i=i, n=n):
                    report((i + frac) / n, msg)

                clip_words = transcriber.transcribe(str(tmp_wav), project.source_lang, clip_report)
                for w in clip_words:
                    w.start += clip.start
                    w.end += clip.start
                words.extend(clip_words)
                tmp_wav.unlink(missing_ok=True)
                logger.log(project_id, "info", f"whisper: clip {i+1}/{n} -> {len(clip_words)} words, {clip.start:.1f}-{clip.end:.1f}")
    except Exception as e:  # noqa: BLE001
        logger.log(
            project_id,
            "error",
            f"transcribe: failed engine={settings.asr_engine} model={settings.whisper_model}: {e!r}",
        )
        raise

    (pdir / "words.json").write_text(
        json.dumps([w.model_dump() for w in words], ensure_ascii=False, indent=2), encoding="utf-8"
    )
    logger.log(project_id, "info", f"whisper: total {len(words)} words saved to words.json")
    return words
