from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import ffmpeg_utils, jobs, logger, projects, settings_store
from .models import Clip, ImageOverlay, Line, Project, ProjectStyle, Settings
from .paths import PROJECTS_DIR, STATIC_DIR, project_dir

app = FastAPI(title="Subtitler")

VALID_EXTS = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".ts", ".m2ts"}
VALID_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


# ---------------------------------------------------------------- static ---
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def root():
    return RedirectResponse("/static/index.html")


# ---------------------------------------------------------- range serving --
def _range_response(file_path: Path, request: Request, media_type: str) -> Response:
    if not file_path.exists():
        raise HTTPException(404, "File not found")
    file_size = file_path.stat().st_size
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(str(file_path), media_type=media_type)

    m = re.match(r"bytes=(\d*)-(\d*)", range_header)
    if not m:
        raise HTTPException(416, "Invalid range")
    start_s, end_s = m.groups()
    start = int(start_s) if start_s else 0
    end = int(end_s) if end_s else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        raise HTTPException(416, "Range not satisfiable")

    chunk_size = end - start + 1
    with open(file_path, "rb") as f:
        f.seek(start)
        data = f.read(chunk_size)

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(chunk_size),
    }
    return Response(content=data, status_code=206, media_type=media_type, headers=headers)


@app.get("/api/projects/{project_id}/preview")
def get_preview(project_id: str, request: Request):
    try:
        proj = projects.load_project(project_id)
    except FileNotFoundError:
        proj = None
    if proj is not None and not proj.has_proxy:
        p = Path(proj.video_path)
    else:
        p = project_dir(project_id) / "preview.mp4"
    return _range_response(p, request, "video/mp4")


@app.get("/api/projects/{project_id}/audio")
def get_audio(project_id: str, request: Request):
    p = project_dir(project_id) / "audio.wav"
    return _range_response(p, request, "audio/wav")


# --------------------------------------------------------------- projects --
@app.get("/api/projects")
def api_list_projects():
    return projects.list_projects()


@app.get("/api/projects/{project_id}")
def api_get_project(project_id: str):
    try:
        return projects.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(404, "Project not found")


@app.patch("/api/projects/{project_id}")
def api_patch_project(project_id: str, body: dict):
    proj = projects.load_project(project_id)
    data = proj.model_dump()
    for key in ("clips", "style", "source_lang", "target_lang", "images"):
        if key in body:
            data[key] = body[key]
    updated = Project.model_validate(data)
    projects.save_project(updated)
    return updated


@app.put("/api/projects/{project_id}/lines")
def api_put_lines(project_id: str, body: dict):
    proj = projects.load_project(project_id)
    raw_lines = body.get("lines", [])
    lines = [Line.model_validate(l) for l in raw_lines]
    for l in lines:
        if l.end <= l.start:
            raise HTTPException(400, f"Line {l.id}: end must be after start")
    proj.lines = lines
    projects.save_project(proj)
    return {"ok": True}


@app.post("/api/projects/{project_id}/images")
async def api_upload_image(project_id: str, file: UploadFile):
    proj = projects.load_project(project_id)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in VALID_IMAGE_EXTS:
        raise HTTPException(400, f"Unsupported image type {ext}. Supported: {', '.join(sorted(VALID_IMAGE_EXTS))}")
    pdir = project_dir(project_id)
    images_dir = pdir / "images"
    images_dir.mkdir(exist_ok=True)
    image_id = uuid.uuid4().hex[:8]
    fname = f"{image_id}{ext}"
    data = await file.read()
    (images_dir / fname).write_bytes(data)
    overlay = ImageOverlay(id=image_id, filename=fname)
    proj.images.append(overlay)
    projects.save_project(proj)
    logger.log(project_id, "info", f"image overlay added: {fname}")
    return proj


@app.get("/api/projects/{project_id}/images/{filename}")
def api_get_image(project_id: str, filename: str):
    p = project_dir(project_id) / "images" / filename
    if not p.exists():
        raise HTTPException(404, "Image not found")
    return FileResponse(str(p))


@app.delete("/api/projects/{project_id}/images/{image_id}")
def api_delete_image(project_id: str, image_id: str):
    proj = projects.load_project(project_id)
    match = next((im for im in proj.images if im.id == image_id), None)
    if not match:
        raise HTTPException(404, "Image overlay not found")
    proj.images = [im for im in proj.images if im.id != image_id]
    projects.save_project(proj)
    fpath = project_dir(project_id) / "images" / match.filename
    fpath.unlink(missing_ok=True)
    logger.log(project_id, "info", f"image overlay removed: {match.filename}")
    return proj


@app.get("/api/projects/{project_id}/log")
def api_get_log(project_id: str):
    return {"log": logger.read_log(project_id)}


@app.delete("/api/projects/{project_id}")
def api_delete_project(project_id: str):
    d = project_dir(project_id)
    if not d.exists():
        raise HTTPException(404, "Project not found")
    shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


# ----------------------------------------------------------------- import --
def _sanitize_stem(stem: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", stem)[:40] or "video"


@app.post("/api/projects")
def api_create_project(body: dict):
    video_path = body.get("video_path", "").strip().strip('"')
    if not video_path:
        raise HTTPException(400, "video_path is required")
    p = Path(video_path)
    if not p.exists() or not p.is_file():
        raise HTTPException(400, f"File not found: {video_path}")
    if p.suffix.lower() not in VALID_EXTS:
        raise HTTPException(400, f"Unsupported extension {p.suffix}. Supported: {', '.join(sorted(VALID_EXTS))}")

    project_id = f"{_sanitize_stem(p.stem)}-{uuid.uuid4().hex[:6]}"
    s = settings_store.load_settings()
    proj = Project(
        id=project_id,
        video_path=str(p.resolve()),
        video_filename=p.name,
        status="importing",
        source_lang=s.default_source_lang,
        target_lang=s.default_target_lang,
    )
    projects.save_project(proj)
    logger.log(project_id, "info", f"project created for {p.name}")

    def _log_ffmpeg_cmd(args: list[str]) -> None:
        full = ["ffmpeg", "-y", *args]
        logger.log(project_id, "info", "ffmpeg: " + " ".join(full))

    def do_import(report):
        report(0.0, "Probing video…")
        logger.log(project_id, "info", "probing video with ffprobe")
        info = ffmpeg_utils.probe(str(p))
        proj2 = projects.load_project(project_id)
        proj2.video_duration = info["duration"]
        proj2.width = info["width"]
        proj2.height = info["height"]
        proj2.fps = info["fps"]
        projects.save_project(proj2)
        logger.log(project_id, "info", f"probe ok: {info}")

        pdir = project_dir(project_id)

        # I2-2: decision ladder — skip/remux/re-encode depending on source codecs.
        is_h264 = info["video_codec"] == "h264"
        is_aac = info["audio_codec"] == "aac"
        is_mp4 = info["container"] == "mp4"
        has_proxy = True

        if is_h264 and is_aac and is_mp4:
            report(0.1, "Source already browser-compatible — skipping proxy…")
            logger.log(project_id, "info", "proxy skipped: source is h264/aac mp4, serving original directly")
            has_proxy = False
            report(0.8, "Proxy skipped")
        elif is_h264 and is_aac:
            report(0.1, "Remuxing preview (fast, no re-encode)…")
            logger.log(project_id, "info", "remuxing (fast, no re-encode)")
            remux_args = ["-i", str(p), "-c", "copy", "-movflags", "+faststart", str(pdir / "preview.mp4")]
            _log_ffmpeg_cmd(remux_args)
            ffmpeg_utils.run_ffmpeg(remux_args)
            logger.log(project_id, "info", "remux done")
            report(0.8, "Remux complete")
        else:
            report(0.1, "Building preview proxy…")
            logger.log(project_id, "info", "re-encoding for browser compatibility — this is the slow step")
            vf = [] if info["height"] and info["height"] <= 720 else ["-vf", "scale=-2:720"]
            encode_args = [
                "-i", str(p),
                *vf,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                "-progress", "pipe:1", "-nostats",
                str(pdir / "preview.mp4"),
            ]
            _log_ffmpeg_cmd(encode_args)
            ffmpeg_utils.run_ffmpeg(
                encode_args,
                on_progress=lambda frac, msg: report(0.1 + 0.7 * frac, "Building preview proxy…"),
                total_duration=info["duration"],
            )
            logger.log(project_id, "info", "preview proxy done")

        proj2b = projects.load_project(project_id)
        proj2b.has_proxy = has_proxy
        projects.save_project(proj2b)

        report(0.82, "Extracting audio…")
        logger.log(project_id, "info", "extracting 16kHz mono audio for whisper/waveform")
        audio_args = ["-i", str(p), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(pdir / "audio.wav")]
        _log_ffmpeg_cmd(audio_args)
        ffmpeg_utils.run_ffmpeg(audio_args)
        logger.log(project_id, "info", "audio extraction done")

        proj3 = projects.load_project(project_id)
        proj3.status = "new"
        projects.save_project(proj3)
        report(1.0, "Import complete")
        return {"project_id": project_id}

    job_id = jobs.start_job("import", do_import, project_id=project_id)
    return {"project_id": project_id, "job_id": job_id}


# -------------------------------------------------------------------- jobs -
@app.get("/api/jobs/{job_id}")
def api_get_job(job_id: str):
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


# ---------------------------------------------------------------- settings -
@app.get("/api/settings")
def api_get_settings():
    s = settings_store.load_settings()
    data = s.model_dump()
    data["llm_api_key"] = settings_store.masked_api_key(s.llm_api_key)
    return data


@app.put("/api/settings")
def api_put_settings(body: dict):
    s = settings_store.load_settings()
    data = s.model_dump()
    for k, v in body.items():
        if k == "llm_api_key" and isinstance(v, str) and v.strip("*") == "" and v != "":
            continue  # masked/unchanged
        if k in data:
            data[k] = v
    updated = Settings.model_validate(data)
    settings_store.save_settings(updated)
    out = updated.model_dump()
    out["llm_api_key"] = settings_store.masked_api_key(updated.llm_api_key)
    return out


@app.post("/api/settings/test")
def api_test_settings():
    from . import translate as translate_mod

    s = settings_store.load_settings()
    ok, message = translate_mod.test_llm_connection(s)
    return {"ok": ok, "message": message}


# ---------------------------------------------------------------- pipeline -
from . import pipeline as pipeline_mod  # noqa: E402


@app.post("/api/projects/{project_id}/pipeline")
def api_run_pipeline(project_id: str):
    proj = projects.load_project(project_id)
    s = settings_store.load_settings()
    if not s.llm_api_key:
        raise HTTPException(400, "No LLM API key set — open Settings (⚙) first.")

    def do_pipeline(report):
        return pipeline_mod.run_pipeline(project_id, report)

    job_id = jobs.start_job("pipeline", do_pipeline, project_id=project_id)
    return {"job_id": job_id}


@app.post("/api/projects/{project_id}/retranslate")
def api_retranslate(project_id: str):
    s = settings_store.load_settings()
    if not s.llm_api_key:
        raise HTTPException(400, "No LLM API key set — open Settings (⚙) first.")

    def do_retranslate(report):
        return pipeline_mod.run_retranslate(project_id, report)

    job_id = jobs.start_job("pipeline", do_retranslate, project_id=project_id)
    return {"job_id": job_id}


# ------------------------------------------------------------------ export -
from . import exporter  # noqa: E402


@app.post("/api/projects/{project_id}/export")
def api_export(project_id: str, body: dict):
    kind = body.get("kind", "mp4")
    track = body.get("track", "translation")
    scope = body.get("scope", "full")
    output_dir = body.get("output_dir") or str(Path(projects.load_project(project_id).video_path).parent)

    def do_export(report):
        return exporter.run_export(project_id, kind, track, scope, output_dir, report)

    job_id = jobs.start_job("export", do_export, project_id=project_id)
    return {"job_id": job_id}
