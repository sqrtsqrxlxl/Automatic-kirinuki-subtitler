from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Callable

from . import ffmpeg_utils, logger, projects
from .models import ImageOverlay, Line, Project, Speaker
from .paths import project_dir

Report = Callable[[float, str], None]


def _fmt_srt_time(t: float) -> str:
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _fmt_ass_time(t: float) -> str:
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    cs = int(round((t - int(t)) * 100))
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def _line_text(line: Line, track: str) -> str:
    if track == "translation":
        return line.text_tgt
    if track == "original":
        return line.text_src
    # bilingual
    return f"{line.text_tgt}\n{line.text_src}"


def write_srt(lines: list[Line], track: str, out_path: Path) -> None:
    parts = []
    for i, line in enumerate(lines, start=1):
        text = _line_text(line, track)
        parts.append(f"{i}\n{_fmt_srt_time(line.start)} --> {_fmt_srt_time(line.end)}\n{text}\n")
    out_path.write_text("\n".join(parts), encoding="utf-8-sig")


def _hex_to_ass_color(hex_color: str) -> str:
    hex_color = hex_color.lstrip("#")
    r, g, b = hex_color[0:2], hex_color[2:4], hex_color[4:6]
    return f"&H00{b.upper()}{g.upper()}{r.upper()}&"


def _resolve(*vals):
    """First non-None value wins — used to layer style fields line > speaker > global."""
    for v in vals:
        if v is not None:
            return v
    return None


def _effective_pos(style, spk_style, ov) -> tuple[float, float] | None:
    """I2-10/I3-7: per-line \\pos override wins over the speaker's position,
    which wins over a global custom position. ASS has no per-style \\pos, so
    this is applied as a Dialogue override tag."""
    if ov is not None and ov.pos_x is not None and ov.pos_y is not None:
        return ov.pos_x, ov.pos_y
    if spk_style is not None and spk_style.pos_x is not None and spk_style.pos_y is not None:
        return spk_style.pos_x, spk_style.pos_y
    if style.pos_x is not None and style.pos_y is not None:
        return style.pos_x, style.pos_y
    return None


def _sanitize_style_name(name: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_]", "_", name).strip("_") or "Speaker"
    return f"Spk_{safe}"


def _style_row(name: str, font, size, color_hex, outline_hex, alignment, style) -> str:
    col = _hex_to_ass_color(color_hex)
    oc = _hex_to_ass_color(outline_hex)
    return (
        f"Style: {name},{font},{size},{col},{col},{oc},&H00000000,0,0,0,0,100,100,0,0,1,"
        f"{style.outline_width},0,{alignment},20,20,{style.margin_v},1"
    )


def write_ass(project: Project, lines: list[Line], track: str, out_path: Path) -> None:
    style = project.style
    alignment = 8 if style.position == "top" else 2
    default_color = _hex_to_ass_color(style.color)
    outline_color = _hex_to_ass_color(style.outline_color)

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{style.font},{style.size},{default_color},{default_color},{outline_color},&H00000000,0,0,0,0,100,100,0,0,1,{style.outline_width},0,{alignment},20,20,{style.margin_v},1
"""

    speakers_by_id: dict[str, Speaker] = {s.id: s for s in project.speakers}

    # I3-7: one Spk_<name> ASS style per speaker referenced by >=1 exported
    # line, built by layering the speaker preset over the project style.
    used_speaker_ids = {l.speaker_id for l in lines if l.speaker_id and l.speaker_id in speakers_by_id}
    speaker_style_rows = []
    speaker_style_names: dict[str, str] = {}
    for sid in used_speaker_ids:
        spk = speakers_by_id[sid]
        sname = _sanitize_style_name(spk.name)
        speaker_style_names[sid] = sname
        sst = spk.style
        speaker_style_rows.append(
            _style_row(
                sname,
                _resolve(sst.font, style.font),
                _resolve(sst.size, style.size),
                _resolve(sst.color, style.color),
                _resolve(sst.outline_color, style.outline_color),
                8 if _resolve(sst.position, style.position) == "top" else 2,
                style,
            )
        )

    extra_styles = list(speaker_style_rows)
    dialogue_rows = []
    for line in lines:
        ov = line.style
        spk = speakers_by_id.get(line.speaker_id) if line.speaker_id else None
        spk_style = spk.style if spk else None

        has_text_override = ov is not None and any(
            getattr(ov, f) is not None for f in ("font", "size", "color", "outline_color", "position")
        )

        if has_text_override:
            # I2-10/I3-7: per-line override keeps winning — layered line >
            # speaker > global, its own dedicated style row.
            style_name = f"Line_{line.id}"
            font = _resolve(ov.font, spk_style.font if spk_style else None, style.font)
            sz = _resolve(ov.size, spk_style.size if spk_style else None, style.size)
            col = _resolve(ov.color, spk_style.color if spk_style else None, style.color)
            oc = _resolve(ov.outline_color, spk_style.outline_color if spk_style else None, style.outline_color)
            pos_field = _resolve(ov.position, spk_style.position if spk_style else None, style.position)
            al = 8 if pos_field == "top" else 2
            extra_styles.append(_style_row(style_name, font, sz, col, oc, al, style))
        elif spk is not None:
            style_name = speaker_style_names.get(line.speaker_id, "Default")
        else:
            style_name = "Default"

        text = _line_text(line, track).replace("\n", "\\N")
        if track == "bilingual":
            zh, ja = line.text_tgt, line.text_src
            small = int(style.size * 0.6)
            text = f"{zh}\\N{{\\fs{small}}}{ja}"

        pos = _effective_pos(style, spk_style, ov)
        if pos is not None:
            X = round(pos[0] * 1920)
            Y = round(pos[1] * 1080)
            text = f"{{\\an2\\pos({X},{Y})}}" + text

        name_field = spk.name if spk is not None else ""
        dialogue_rows.append(
            f"Dialogue: 0,{_fmt_ass_time(line.start)},{_fmt_ass_time(line.end)},{style_name},{name_field},0,0,0,,{text}"
        )

    body = "\n".join(extra_styles) + ("\n" if extra_styles else "") + \
        "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + \
        "\n".join(dialogue_rows)

    out_path.write_text(header + body + "\n", encoding="utf-8-sig")


def _shift_lines_for_clip(lines: list[Line], clip_start: float, clip_end: float) -> list[Line]:
    out = []
    for line in lines:
        if line.end <= clip_start or line.start >= clip_end:
            continue
        shifted = copy.deepcopy(line)
        shifted.start = max(0.0, line.start - clip_start)
        shifted.end = min(clip_end - clip_start, line.end - clip_start)
        out.append(shifted)
    return out


def _shift_images_for_clip(images: list[ImageOverlay], clip_start: float, clip_end: float) -> list[ImageOverlay]:
    """I2-11: shift image overlay time windows by the clip start and drop
    overlays fully outside the clip."""
    out = []
    clip_dur = clip_end - clip_start
    for im in images:
        if im.start >= clip_end:
            continue
        if im.end is not None and im.end <= clip_start:
            continue
        shifted = im.model_copy(deep=True)
        shifted.start = max(0.0, im.start - clip_start)
        shifted.end = None if im.end is None else max(0.0, min(clip_dur, im.end - clip_start))
        out.append(shifted)
    return out


def _build_image_filter_complex(
    images: list[ImageOverlay],
    image_dir: Path,
    ass_filename: str,
    frame_w: int,
    frame_h: int,
    total_duration: float,
) -> tuple[list[str], str]:
    """I2-11: build extra -i args + a -filter_complex chain that overlays each
    image (scaled + positioned + time-gated) then burns subtitles LAST so
    they always render on top. Returns (extra_input_args, filter_complex_str)."""
    input_args: list[str] = []
    for im in images:
        input_args += ["-i", str(image_dir / im.filename)]

    parts: list[str] = []
    prev_label = "0:v"
    for idx, im in enumerate(images):
        img_stream = idx + 1  # -i index; 0 is the main video
        scaled_label = f"img{idx}"
        W = max(2, round(im.width * frame_w))
        X = round(im.x * frame_w)
        Y = round(im.y * frame_h)
        end = im.end if im.end is not None else total_duration
        out_label = f"v{idx + 1}"
        parts.append(f"[{img_stream}:v]scale={W}:-1[{scaled_label}]")
        parts.append(
            f"[{prev_label}][{scaled_label}]overlay={X}:{Y}:enable='between(t,{im.start},{end})'[{out_label}]"
        )
        prev_label = out_label

    parts.append(f"[{prev_label}]subtitles={ass_filename}[vout]")
    return input_args, ";".join(parts)


def _burn_mp4(
    project: Project,
    ass_path: Path,
    images: list[ImageOverlay],
    src_video: str,
    out_path: Path,
    pdir: Path,
    total_duration: float,
    ss: float | None,
    to: float | None,
    report: Report,
    audio_codec_args: list[str],
) -> None:
    """Shared MP4 burn-in for full and per-clip export, with or without image
    overlays. `cwd=pdir` keeps the `subtitles=` filter's relative filename
    trick working (ffmpeg's filter parser chokes on Windows absolute paths
    with `:` and `\\`)."""
    trim_args = []
    if ss is not None:
        trim_args += ["-ss", str(ss)]
    if to is not None:
        trim_args += ["-to", str(to)]

    if images:
        extra_inputs, filter_complex = _build_image_filter_complex(
            images, pdir / "images", ass_path.name, project.width or 1920, project.height or 1080, total_duration
        )
        args = [
            *trim_args,
            "-i", src_video,
            *extra_inputs,
            "-filter_complex", filter_complex,
            "-map", "[vout]", "-map", "0:a",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            *audio_codec_args,
            "-progress", "pipe:1", "-nostats",
            str(out_path),
        ]
    else:
        args = [
            *trim_args,
            "-i", src_video,
            "-vf", f"subtitles={ass_path.name}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            *audio_codec_args,
            "-progress", "pipe:1", "-nostats",
            str(out_path),
        ]

    ffmpeg_utils.run_ffmpeg(
        args,
        cwd=pdir,
        on_progress=lambda frac, msg: report(frac, "Burning subtitles…"),
        total_duration=total_duration,
    )


def run_export(project_id: str, kind: str, track: str, scope: str, output_dir: str, report: Report) -> dict:
    project = projects.load_project(project_id)
    pdir = project_dir(project_id)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(project.video_filename).stem or project.id

    logger.log(project_id, "info", f"export: kind={kind} track={track} scope={scope} -> {out_dir}")

    if kind in ("srt", "ass"):
        if scope == "clips" and project.clips:
            out_paths = []
            for i, clip in enumerate(project.clips):
                clip_lines = _shift_lines_for_clip(project.lines, clip.start, clip.end)
                out_path = out_dir / f"{stem}.clip{i + 1:02d}.{kind}"
                if kind == "srt":
                    write_srt(clip_lines, track, out_path)
                else:
                    write_ass(project, clip_lines, track, out_path)
                out_paths.append(str(out_path))
            report(1.0, "Export complete")
            return {"output_paths": out_paths}
        else:
            out_path = out_dir / f"{stem}.{kind}"
            if kind == "srt":
                write_srt(project.lines, track, out_path)
            else:
                write_ass(project, project.lines, track, out_path)
            report(1.0, "Export complete")
            return {"output_path": str(out_path)}

    # kind == "mp4"
    if scope == "clips" and project.clips:
        out_paths = []
        n = len(project.clips)
        for i, clip in enumerate(project.clips):
            clip_lines = _shift_lines_for_clip(project.lines, clip.start, clip.end)
            clip_images = _shift_images_for_clip(project.images, clip.start, clip.end)
            ass_path = pdir / f"burn_clip{i + 1:02d}.ass"
            write_ass(project, clip_lines, track, ass_path)
            out_path = out_dir / f"{stem}.clip{i + 1:02d}.mp4"
            clip_dur = clip.end - clip.start

            def prog(frac, msg, i=i, n=n):
                report((i + frac) / n, f"Exporting clip {i + 1}/{n}…")

            _burn_mp4(
                project, ass_path, clip_images, project.video_path, out_path, pdir,
                clip_dur, clip.start, clip.end, prog, ["-c:a", "aac", "-b:a", "192k"],
            )
            out_paths.append(str(out_path))
            logger.log(project_id, "info", f"export: clip {i + 1}/{n} -> {out_path}")
        report(1.0, "Export complete")
        return {"output_paths": out_paths}
    else:
        ass_path = pdir / "burn.ass"
        write_ass(project, project.lines, track, ass_path)
        out_path = out_dir / f"{stem}.mp4"
        try:
            _burn_mp4(
                project, ass_path, project.images, project.video_path, out_path, pdir,
                project.video_duration, None, None, report, ["-c:a", "copy"],
            )
        except ffmpeg_utils.FfmpegError:
            logger.log(project_id, "warn", "export: -c:a copy failed, retrying with aac re-encode")
            _burn_mp4(
                project, ass_path, project.images, project.video_path, out_path, pdir,
                project.video_duration, None, None, report, ["-c:a", "aac", "-b:a", "192k"],
            )
        logger.log(project_id, "info", f"export: mp4 -> {out_path}")
        report(1.0, "Export complete")
        return {"output_path": str(out_path)}
