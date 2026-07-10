from __future__ import annotations

from pydantic import BaseModel, Field


class Word(BaseModel):
    start: float
    end: float
    text: str


class StyleOverride(BaseModel):
    font: str | None = None
    size: int | None = None
    color: str | None = None
    outline_color: str | None = None
    position: str | None = None  # "bottom" | "top"
    pos_x: float | None = None  # fraction 0-1 of frame width, bottom-center anchor
    pos_y: float | None = None  # fraction 0-1 of frame height


class Line(BaseModel):
    id: str
    start: float
    end: float
    text_src: str
    text_tgt: str
    style: StyleOverride | None = None


class Clip(BaseModel):
    start: float
    end: float
    title: str = ""
    note: str = ""


class ProjectStyle(BaseModel):
    font: str = "Microsoft YaHei"
    size: int = 48
    color: str = "#FFFFFF"
    outline_color: str = "#000000"
    outline_width: int = 2
    position: str = "bottom"  # "bottom" | "top"
    margin_v: int = 40
    bilingual: bool = False
    pos_x: float | None = None  # fraction 0-1 of frame width, bottom-center anchor; None = classic bottom/top+margin
    pos_y: float | None = None  # fraction 0-1 of frame height


class ImageOverlay(BaseModel):
    id: str
    filename: str
    x: float = 0.05  # top-left, fraction of frame width
    y: float = 0.05  # top-left, fraction of frame height
    width: float = 0.3  # fraction of frame width; height auto from aspect
    start: float = 0
    end: float | None = None  # None = until video end


class Project(BaseModel):
    id: str
    video_path: str
    video_filename: str = ""
    video_duration: float = 0
    fps: float = 0
    width: int = 0
    height: int = 0
    has_proxy: bool = True
    clips: list[Clip] = Field(default_factory=list)
    lines: list[Line] = Field(default_factory=list)
    images: list[ImageOverlay] = Field(default_factory=list)
    style: ProjectStyle = Field(default_factory=ProjectStyle)
    source_lang: str = "ja"
    target_lang: str = "zh"
    status: str = "new"  # new | importing | transcribing | translating | ready | error
    translation_status: str = "ok"  # "ok" | "failed" | "partial"
    translation_error: str = ""


class Settings(BaseModel):
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"
    pipeline: str = "two_stage"
    asr_engine: str = "faster-whisper"  # "faster-whisper" | "stable-ts"
    whisper_model: str = "large-v3"
    whisper_device: str = "auto"
    whisper_compute_type: str = "auto"
    default_source_lang: str = "ja"
    default_target_lang: str = "zh"
