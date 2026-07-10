from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Callable


class FfmpegError(Exception):
    pass


def _run(args: list[str], cwd: str | Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def probe(video_path: str) -> dict:
    """Return {duration, width, height, fps, video_codec, audio_codec, container} via ffprobe."""
    args = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate,codec_name",
        "-show_entries", "format=duration",
        "-of", "json",
        video_path,
    ]
    proc = _run(args)
    if proc.returncode != 0:
        raise FfmpegError(proc.stderr[-3000:])
    data = json.loads(proc.stdout)
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}
    fr = stream.get("avg_frame_rate", "0/1")
    try:
        num, den = fr.split("/")
        fps = float(num) / float(den) if float(den) != 0 else 0.0
    except Exception:
        fps = 0.0

    audio_codec = ""
    a_args = [
        "ffprobe", "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name",
        "-of", "json",
        video_path,
    ]
    a_proc = _run(a_args)
    if a_proc.returncode == 0:
        try:
            a_data = json.loads(a_proc.stdout)
            a_stream = (a_data.get("streams") or [{}])[0]
            audio_codec = a_stream.get("codec_name", "")
        except Exception:
            audio_codec = ""

    return {
        "duration": float(fmt.get("duration", 0.0)),
        "width": int(stream.get("width", 0)),
        "height": int(stream.get("height", 0)),
        "fps": fps,
        "video_codec": stream.get("codec_name", ""),
        "audio_codec": audio_codec,
        "container": Path(video_path).suffix.lower().lstrip("."),
    }


def _parse_progress_stream(proc: subprocess.Popen, total_duration: float, on_progress: Callable[[float, str], None] | None):
    time_re = re.compile(r"out_time_ms=(\d+)")
    for line in proc.stderr:  # ffmpeg -progress pipe writes to stdout normally; we redirect below
        if on_progress and total_duration > 0:
            m = time_re.search(line)
            if m:
                out_ms = int(m.group(1))
                frac = min(1.0, (out_ms / 1_000_000) / total_duration)
                on_progress(frac, "Encoding…")


def run_ffmpeg(args: list[str], cwd: str | Path | None = None, on_progress: Callable[[float, str], None] | None = None, total_duration: float = 0.0) -> None:
    """Run ffmpeg. If on_progress given, expects '-progress pipe:1' present in args."""
    full_args = ["ffmpeg", "-y", *args]
    if on_progress:
        proc = subprocess.Popen(
            full_args, cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        time_re = re.compile(r"out_time_ms=(\d+)")
        stderr_tail: list[str] = []
        for line in proc.stdout:
            stderr_tail.append(line)
            if len(stderr_tail) > 60:
                stderr_tail.pop(0)
            m = time_re.search(line)
            if m and total_duration > 0:
                out_ms = int(m.group(1))
                frac = min(1.0, (out_ms / 1_000_000) / total_duration)
                on_progress(frac, "Encoding…")
        proc.wait()
        if proc.returncode != 0:
            raise FfmpegError("".join(stderr_tail[-30:]))
    else:
        proc = _run(full_args, cwd=cwd)
        if proc.returncode != 0:
            raise FfmpegError(proc.stderr[-3000:])
