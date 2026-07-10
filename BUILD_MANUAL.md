# Subtitler — Build Manual for the Implementation Agent

You are an implementation agent. Your job is to build this application **exactly as specified in this document**. Read this entire file before writing any code.

## Rules for you, the agent

1. **Build in phases, in order.** Each phase ends with a VERIFY section. Run every verification step. Do not start the next phase until every check in the current phase passes.
2. **Do not invent features.** If something is not specified here, use the simplest implementation that satisfies the spec. Do not add login systems, databases, Docker, React, build steps, or cloud services.
3. **Do not substitute technologies.** The stack is fixed: Python 3.11+, FastAPI, vanilla HTML/CSS/JS frontend, faster-whisper, the `openai` Python package (pointed at a configurable base URL), ffmpeg, wavesurfer.js.
4. **When a command fails, read the error and fix the actual cause.** Do not retry the same command unchanged more than once.
5. **All timestamps in code and JSON are floating-point seconds** (e.g. `754.42`), measured from the start of the ORIGINAL video. Only convert to `HH:MM:SS,mmm` / `H:MM:SS.cc` formats inside the SRT/ASS writers. Never store formatted time strings in the data model.
6. **Target OS is Windows 11.** Watch for the Windows-specific gotchas called out in this document, especially around ffmpeg subtitle burning.
7. Commit to git after each phase with message `Phase N: <title>` (run `git init` first if the folder is not a repo).

---

## 1. What this application is

A local, single-user subtitling tool. The user:

1. Loads a video file, previews it, and optionally marks one or more clip ranges on a timeline. Default action = process the whole video.
2. Clicks a button. The app transcribes the audio with faster-whisper (Japanese by default), then sends the word-timestamped transcript to an OpenAI-compatible LLM which (a) splits it into subtitle-length lines and (b) translates each line into Chinese.
3. Lands in an Aegisub-style editor: video preview with live subtitle overlay, audio waveform for retiming, a grid of subtitle lines, inline text editing, styling controls.
4. Exports either an MP4 with burned-in subtitles or a standalone subtitle file (.srt / .ass).

Everything runs locally except the LLM API call. The app starts with `python run.py`, which launches a FastAPI server on `http://127.0.0.1:8765` and opens the default browser to it.

---

## 2. Environment setup (Phase 0)

Create this folder structure inside the current working directory:

```
subtitler/
  run.py                  # entry point: starts uvicorn, opens browser
  requirements.txt
  settings.json           # created on first run if missing (see §10)
  app/
    __init__.py
    main.py               # FastAPI app, serves API + static files
    models.py             # dataclasses / pydantic models (§3)
    projects.py           # project load/save helpers
    jobs.py               # background job manager (§4.4)
    transcribe.py         # faster-whisper wrapper (Phase 2)
    translate.py          # LLM segmentation+translation (Phase 3)
    exporter.py           # SRT/ASS writers + ffmpeg burn (Phase 5)
    ffmpeg_utils.py       # ffmpeg helpers: probe, proxy, audio extract
  static/
    index.html            # Screen 1: import & clip selection
    editor.html           # Screen 2: editor / QC
    css/app.css
    js/screen1.js
    js/editor.js
    js/api.js             # small fetch wrapper shared by both screens
    vendor/               # downloaded JS libs live here (no CDN at runtime)
  projects/               # one subfolder per imported video (created at runtime)
```

`requirements.txt`:

```
fastapi
uvicorn[standard]
faster-whisper
stable-ts
openai
pydantic
```

Note: `stable-ts` pulls in PyTorch (~2 GB). Install it anyway — it is the alternative ASR engine (§5.1) and must work out of the box.

Setup steps:

1. Create a venv: `python -m venv .venv`, then use `.venv\Scripts\python.exe` for everything.
2. `pip install -r requirements.txt`
3. Verify ffmpeg: run `ffmpeg -version` and `ffprobe -version`. If not found, tell the user to install it (e.g. `winget install Gyan.FFmpeg`) and stop until it is available.
4. Download wavesurfer.js v7 (UMD builds) into `static/vendor/`:
   - `https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.min.js`
   - `https://unpkg.com/wavesurfer.js@7/dist/plugins/regions.min.js`
   Save them as local files. The HTML must reference these local copies, never a CDN.

**VERIFY Phase 0:** `pip list` shows all five packages; `ffmpeg -version` prints a version; both vendor files exist and are non-empty (>50 KB each).

---

## 3. Data model (`app/models.py`)

Use pydantic models. These exact fields, these exact names:

```python
class Word(BaseModel):
    start: float          # seconds, absolute in original video
    end: float
    text: str

class StyleOverride(BaseModel):
    # every field optional; None = inherit from project style
    font: str | None = None
    size: int | None = None
    color: str | None = None        # "#RRGGBB"
    outline_color: str | None = None
    position: str | None = None     # "bottom" | "top"

class Line(BaseModel):
    id: str               # short uuid hex, e.g. uuid4().hex[:8]
    start: float
    end: float
    text_src: str         # original-language text (Japanese)
    text_tgt: str         # translated text (Chinese)
    style: StyleOverride | None = None

class Clip(BaseModel):
    start: float
    end: float

class ProjectStyle(BaseModel):
    font: str = "Microsoft YaHei"
    size: int = 48                  # in ASS PlayResY=1080 units
    color: str = "#FFFFFF"
    outline_color: str = "#000000"
    outline_width: int = 2
    position: str = "bottom"        # "bottom" | "top"
    margin_v: int = 40
    bilingual: bool = False         # if True, show text_src as smaller second row

class Project(BaseModel):
    id: str                         # folder name, see §4.2
    video_path: str                 # absolute path to ORIGINAL video
    video_duration: float
    fps: float
    width: int
    height: int
    clips: list[Clip] = []          # empty list = whole video
    lines: list[Line] = []
    style: ProjectStyle = ProjectStyle()
    source_lang: str = "ja"
    target_lang: str = "zh"
    status: str = "new"             # "new" | "transcribing" | "translating" | "ready"
```

Persistence: each project is a folder `projects/<id>/` containing `project.json` (the `Project` model serialized with `model_dump_json(indent=2)`) plus generated media files. `app/projects.py` exposes `load_project(id) -> Project`, `save_project(p: Project)`, `list_projects() -> list[dict]` (id, video filename, status, duration). Every mutating API endpoint saves the project to disk before returning.

---

## 4. Phase 1 — App skeleton, import, preview, clip selection

### 4.1 Server (`app/main.py`, `run.py`)

- FastAPI app. Mount `static/` at `/static`. `GET /` redirects to `/static/index.html`.
- `run.py`: starts `uvicorn app.main:app` on port 8765 in a thread or via `uvicorn.run`, and calls `webbrowser.open("http://127.0.0.1:8765")` after a 1-second delay.

### 4.2 Import endpoint

`POST /api/projects` with JSON body `{"video_path": "<absolute path typed/pasted by user>"}`.

The frontend does NOT upload the file (videos are large). The user pastes/browses the absolute path of a file already on disk. Implementation:

1. Validate the path exists and the extension is one of `.mp4 .mkv .mov .avi .webm .ts .m2ts`. Return HTTP 400 with a clear message otherwise.
2. Create project id: `<video filename stem, sanitized to [a-zA-Z0-9_-]>-<uuid4().hex[:6]>`.
3. Probe the video with ffprobe (in `ffmpeg_utils.py`):
   `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate -show_entries format=duration -of json <path>` — parse duration, width, height, fps (`avg_frame_rate` is a fraction like `24000/1001`; evaluate it).
4. Kick off a **background job** (§4.4) that builds a browser-safe preview proxy:
   `ffmpeg -y -i <input> -vf "scale=-2:720" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart projects/<id>/preview.mp4`
   Always build the proxy, even if the source is already MP4 (guarantees browser compatibility and keeps seeking snappy).
5. In the same job, extract waveform/transcription audio:
   `ffmpeg -y -i <input> -vn -ac 1 -ar 16000 -c:a pcm_s16le projects/<id>/audio.wav`
6. Save `project.json`, return `{"project_id": ..., "job_id": ...}`.

Serve media with `GET /api/projects/{id}/preview` and `GET /api/projects/{id}/audio` using `FileResponse`. **Gotcha:** the HTML5 `<video>` element needs HTTP Range support for seeking. FastAPI's `FileResponse` does not do Range. Use `starlette.staticfiles.StaticFiles` mounted per request is not possible — instead implement a small range-aware file responder: read the `Range` header, return 206 with the requested byte slice and `Accept-Ranges`/`Content-Range` headers. This is ~30 lines; write it once in `main.py` and use it for both media endpoints.

### 4.3 Project CRUD endpoints

- `GET /api/projects` → list for a "recent projects" section on screen 1.
- `GET /api/projects/{id}` → full `Project` JSON.
- `PATCH /api/projects/{id}` → accepts partial JSON (`clips`, `style`, `source_lang`, `target_lang`); merge into the model and save.
- `PUT /api/projects/{id}/lines` → replaces the whole `lines` array (the editor autosaves this way). Validate every line has `end > start`.

### 4.4 Background job manager (`app/jobs.py`)

Long tasks (proxy build, transcription, translation, export) run in `threading.Thread`s. Keep a module-level dict `JOBS: dict[str, Job]` where

```python
class Job(BaseModel):
    id: str
    kind: str            # "import" | "pipeline" | "export"
    status: str          # "running" | "done" | "error"
    progress: float      # 0.0 – 1.0
    message: str         # human-readable current step, e.g. "Transcribing 12:30/47:02"
    result: dict | None  # e.g. {"output_path": ...} for exports
    error: str | None
```

`GET /api/jobs/{id}` returns it. Frontend polls every 1000 ms. Worker functions receive a callback `report(progress: float, message: str)`.

### 4.5 Screen 1 frontend (`index.html`, `screen1.js`)

Layout, top to bottom:

1. **Import bar**: text input for the video path + "Load video" button + list of recent projects (click to reopen — goes straight to the editor if `status == "ready"`, otherwise back to screen 1 state).
2. **Video preview**: `<video controls>` pointing at the preview endpoint. Hidden until the import job finishes; show job progress meanwhile.
3. **Clip timeline**: a wavesurfer.js instance loading `/api/projects/{id}/audio`, with the **Regions plugin**. Buttons:
   - "Add clip at playhead" → creates a region from current time to current time + 60 s (clamped to duration). Regions are draggable and edge-resizable.
   - "Clear clips" → removes all regions.
   - Clicking the waveform seeks the `<video>`; keep video `currentTime` and wavesurfer in sync both ways (guard against feedback loops with a small epsilon check, e.g. only push if difference > 0.25 s).
4. **Action buttons**:
   - "Translate whole video" (visually the primary button, always enabled).
   - "Translate selected clips" (enabled only when ≥1 region exists).
   Both: save regions into `project.clips` via PATCH (whole video → `clips: []`), then `POST /api/projects/{id}/pipeline` (Phase 2/3), then show a progress panel polling the job. When the job is done, navigate to `editor.html?project=<id>`.

Keep styling minimal and dark: single CSS file, system font stack, dark gray background (`#1e1e1e`), light text. No CSS framework.

**VERIFY Phase 1:**
- Start the app, paste a real video path, watch the import job reach done.
- Video plays and **seeking works** (jump to the middle — if it doesn't seek, your Range implementation is broken).
- Waveform renders; you can add, drag, resize, and clear clip regions; clicking the waveform seeks the video.
- `projects/<id>/project.json` exists and reloading the browser restores the project via the recent list.

---

## 5. Phase 2 — Transcription (`app/transcribe.py`)

`POST /api/projects/{id}/pipeline` starts one background job that runs transcription (this phase) then translation (Phase 3). Set `project.status` as it moves through the stages.

### 5.1 Transcriber abstraction — build BOTH engines

Transcription is behind a strategy interface. The contract: every engine returns the same flat `list[Word]`. Nothing downstream may know which engine ran.

```python
class Transcriber(Protocol):
    def transcribe(self, audio_path: str, lang: str | None, report) -> list[Word]: ...

def get_transcriber(settings) -> Transcriber:
    engines = {"faster-whisper": FasterWhisperTranscriber, "stable-ts": StableTsTranscriber}
    return engines[settings.asr_engine](settings)
```

Each engine class loads its model **once** and caches it in a module-level dict keyed by `(engine, model_name, device, compute_type)` — never reload per request. Loading can take minutes on first run (model download): report `message="Downloading/loading ASR model…"` first.

**Engine A — `FasterWhisperTranscriber`** (`asr_engine: "faster-whisper"`, the default):

```python
from faster_whisper import WhisperModel
model = WhisperModel(settings.whisper_model, device=settings.whisper_device,
                     compute_type=settings.whisper_compute_type)
segments, info = model.transcribe(
    audio_path,
    language=lang or None,                  # "ja"; None = autodetect
    word_timestamps=True,
    vad_filter=True,
    vad_parameters={"min_silence_duration_ms": 500},
)
```

`segments` is a generator: iterating it IS the transcription. Report progress from `segment.end / total_duration` inside the loop.

**Engine B — `StableTsTranscriber`** (`asr_engine: "stable-ts"`): same faster-whisper model underneath, but stable-ts refines word timestamps against the audio's actual silence and suppresses hallucinated repetition loops (Whisper's failure mode on music/BGM sections).

```python
import stable_whisper   # import INSIDE the class, not module top-level
model = stable_whisper.load_faster_whisper(settings.whisper_model,
            device=settings.whisper_device, compute_type=settings.whisper_compute_type)
result = model.transcribe(audio_path, language=lang or None,
                          word_timestamps=True, vad=True)
# result is a stable_whisper.WhisperResult: iterate result.segments -> seg.words
```

stable-ts returns the full result at once (no streaming): report a static `message="Transcribing (stable-ts)…"` with `progress=0.5` for the duration, then 1.0.

**Model names:** `settings.whisper_model` is passed straight to the loader, so Hugging Face CT2 repos work as model names. The settings UI (§9) offers these presets in a dropdown (plus free text):

- `large-v3` — default, any language
- `medium` — faster, weaker
- `kotoba-tech/kotoba-whisper-v2.0-faster` — Japanese-only distil model, ~6× faster than large-v3 on JA speech. **Guard:** if this model is selected and `project.source_lang != "ja"`, fail the pipeline immediately with `"kotoba-whisper only supports Japanese — switch model or set source language to ja."`

**Word flattening (both engines): ignore segment boundaries.** Flatten everything into one `list[Word]`: for each segment, for each `word` in `segment.words`, append `Word(start=word.start, end=word.end, text=word.word)`. This flat word list is the only transcription output we keep.

### 5.2 Clip handling

If `project.clips` is non-empty, do NOT transcribe the whole file. For each clip, extract that range to a temp wav:
`ffmpeg -y -ss <start> -to <end> -i projects/<id>/audio.wav -c copy <tmp>.wav`
Transcribe each temp wav separately, then **add the clip's `start` to every word timestamp** so all words are in original-video time. Concatenate the word lists in clip order. Delete temp files.

Save the word list to `projects/<id>/words.json` (list of Word dicts) so translation can be re-run without re-transcribing.

### 5.3 Pipeline seam (for future whole-pipeline alternatives)

Structure the pipeline job as a dispatch, even though only one implementation exists today:

```python
class SubtitlePipeline(Protocol):
    def run(self, project: Project, report) -> list[Line]: ...

class TwoStagePipeline:
    def run(self, project, report):
        words = ...   # this phase (§5.1–5.2)
        return ...    # Phase 3 segmentation+translation

PIPELINES = {"two_stage": TwoStagePipeline}
# the /pipeline endpoint runs: PIPELINES[settings.pipeline]().run(project, report)
```

`settings.pipeline` defaults to `"two_stage"` and is the only registered value. Do NOT build any other pipeline; the registry exists so an end-to-end multimodal pipeline (audio → timestamped translated lines in one model call) can be added later without touching the editor or exporter, which only ever read `project.lines`.

**VERIFY Phase 2:** run the pipeline on a short Japanese video (or any video with `source_lang` adjusted). Confirm `words.json` exists, words have strictly increasing sensible timestamps, and clip-mode timestamps are offset correctly (a word spoken 10 s into a clip that starts at 60 s must have `start ≈ 70`). Then switch `asr_engine` to `"stable-ts"` and re-run: it must complete and produce a valid `words.json` too. Finally set model to `kotoba-tech/kotoba-whisper-v2.0-faster` with `source_lang: "en"` and confirm the guard error appears.

---

## 6. Phase 3 — Segmentation + translation via LLM (`app/translate.py`)

This stage turns the flat word list into `Line` objects. **Design principle: the LLM chooses boundaries and writes translations, but Python computes all timestamps from word indices. Never let the LLM output timestamps.**

### 6.1 Client

Use the `openai` package:

```python
from openai import OpenAI
client = OpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key)
```

`settings.llm_model` holds the model name. This works with OpenAI, DeepSeek, Ollama, LM Studio, etc.

### 6.2 Chunking

Process the word list in chunks of **300 words with 30 words of overlap context** (overlap is shown to the model as context but boundaries from overlap regions are discarded — simpler rule below). Implementation rule to keep it simple and correct:

- Chunk k covers words `[k*300, (k+1)*300)`.
- When building the prompt for chunk k, also include the last 2 already-finalized source lines as "previous context" and the next 30 words as "upcoming context" (marked as context, not to be segmented).
- The model segments ONLY the 300 in-scope words.

### 6.3 Prompt

System message (use verbatim, substituting the language names):

```
You are a professional subtitler translating Japanese dialogue into Simplified Chinese.
You receive a numbered list of transcribed words. Your tasks:
1. Group consecutive words into subtitle lines. Each line must be a natural
   phrase or sentence fragment. HARD LIMITS: a line covers at most 12 words
   of source text AND its Chinese translation must be at most 25 characters.
   Prefer breaking at sentence ends, clause boundaries, and pauses.
2. Translate each line into natural, colloquial Simplified Chinese, using the
   surrounding lines as context. Do not add words that were not spoken.
Return ONLY a JSON object of this exact shape, no markdown fences, no commentary:
{"lines": [{"first_word": <int>, "last_word": <int>, "translation": "<Chinese text>"}]}
Rules for indices: use the word numbers given in the input; lines must be
contiguous, non-overlapping, in order, and together cover EVERY in-scope word
exactly once (first line starts at the first in-scope word, each next line
starts at previous last_word + 1, final line ends at the last in-scope word).
```

User message format:

```
PREVIOUS CONTEXT (already subtitled, do not re-segment):
<previous 2 source lines, or "(none)">

IN-SCOPE WORDS (segment and translate exactly these):
137: そして
138: 私たちは
...

UPCOMING CONTEXT (do not segment, for reference only):
<plain text of next 30 words, or "(none)">
```

Call with `temperature=0.3`. If the provider supports `response_format={"type": "json_object"}`, use it inside a try/except and fall back to a plain call if the provider rejects it.

### 6.4 Validation and retry

Parse the response with `json.loads` (first strip markdown fences if present: remove leading ```` ```json ```` / ```` ``` ```` lines). Then validate:

- every `first_word`/`last_word` is an int within the in-scope range,
- lines are contiguous, ordered, and cover the range exactly (per the rules above),
- every `translation` is a non-empty string.

If validation fails, retry **once** with the validation error appended to the user message ("Your previous answer was invalid because: ... Return corrected JSON only."). If it fails again, **fall back to rule-based segmentation for that chunk**: greedily group words into lines of ≤ 10 words, breaking early whenever the gap between consecutive words exceeds 0.6 s or a word ends with `。｡．！？!?`; set `text_tgt` to the empty string and log a warning (the user will see the untranslated source text in the editor and can fix it).

### 6.5 Building lines

For each validated line: `start = words[first_word].start`, `end = words[last_word].end`, `text_src = "".join(w.text for w in words[first:last+1]).strip()` (faster-whisper word texts carry their own leading spaces where relevant; simple concatenation then strip is correct for Japanese), `text_tgt = translation`.

Post-processing on the full list, in this order:

1. **Minimum duration:** if `end - start < 1.0`, extend `end` to `start + 1.0` (but never past the next line's start).
2. **Gap snapping:** if the gap to the next line is < 0.2 s, set this line's `end` to the next line's `start` (removes flicker).
3. **No overlaps:** if `line.end > next.start`, clamp `line.end = next.start`.

Save into `project.lines`, set `status = "ready"`, save the project. Progress reporting: `chunk_index / total_chunks`.

Also expose `POST /api/projects/{id}/retranslate` which re-runs Phase 3 only, from the saved `words.json` (used when the user changes LLM settings or target language).

**VERIFY Phase 3:** run the full pipeline on a 1–3 minute Japanese clip. Inspect `project.json`: lines are ordered, non-overlapping, all ≤ 25 Chinese chars, timestamps line up with the audio when spot-checked in the editor (next phase — for now check a few against the video manually). Verify the fallback path by temporarily setting an invalid API key: pipeline must complete with untranslated rule-based lines, not crash.

---

## 7. Phase 4 — Editor screen (`editor.html`, `editor.js`)

Reads `?project=<id>`, loads the project, and lays out four areas:

```
+--------------------------------+----------------------------+
|  video preview                 |  line inspector            |
|  (subtitle overlay on top)     |  start/end, style, text    |
+--------------------------------+----------------------------+
|  waveform (wavesurfer + regions, one region = active line)  |
+-------------------------------------------------------------+
|  subtitle grid (scrollable table of all lines)              |
+-------------------------------------------------------------+
```

### 7.1 Video + subtitle overlay

- Same range-served preview video.
- Overlay: an absolutely-positioned `<div>` over the video (bottom-center or top-center per style). On every `timeupdate` AND on a 100 ms `setInterval` (timeupdate alone fires too rarely), find the line where `start <= t < end` (binary search or linear scan is fine) and render `text_tgt`; if `style.bilingual`, render `text_src` beneath at 60% font size. Apply project style (font, color, outline via `text-shadow: 2px 2px 0 <outline>, -2px -2px 0 <outline>, ...` 4-direction shadow) plus per-line overrides. Scale font size relative to the rendered video height: `fontpx = style.size * videoClientHeight / 1080`.

### 7.2 Subtitle grid

Table with columns: `#`, `Start`, `End`, `CPS`, `Translation`, `Original`. One row per line.

- Click a row → select the line: video seeks to `line.start`, waveform scrolls there, inspector fills.
- Double-click the Translation cell → inline `<input>` edit; Enter commits, Esc cancels.
- `CPS` = Chinese characters / duration; render the cell red when > 15 (quality-check aid).
- Keyboard shortcuts (when grid is focused): `↑/↓` move selection, `Space` play/pause, `Enter` edit translation.
- Row buttons (or a small toolbar acting on the selected line): **Split** (splits at the video's current time if it lies inside the line; text is split at the proportional character position, user fixes wording afterwards), **Merge with next** (concatenate texts, `end = next.end`), **Delete**, **Insert after** (1.5 s empty line starting at selected line's end).

### 7.3 Line inspector

For the selected line: numeric start/end fields (accept `MM:SS.mmm` or plain seconds; write a single parse/format helper pair and unit-test it mentally with `01:02.500` → `62.5`), the translation textarea, the original text (read-only), and per-line style overrides (font, size, color pickers, position dropdown) with a "reset to project style" button.

### 7.4 Waveform retiming

wavesurfer instance on the audio endpoint with the Regions plugin, but show **only the selected line** as a region (creating hundreds of regions is slow). When selection changes, remove the old region and add one for the new line, then `wavesurfer.setScrollTime(line.start - 2)`. Dragging/resizing the region updates the line's start/end (live in the UI, saved on `region-update-end`).

### 7.5 Project style panel + autosave

- A collapsible "Style" panel with the `ProjectStyle` fields and the bilingual toggle; changes apply to the overlay immediately and PATCH the project (debounced 500 ms).
- Line edits autosave: debounce 800 ms after any change, `PUT /api/projects/{id}/lines` with the full array. Show a tiny "saved ✓ / saving…" indicator.
- Header: project name, "← back" link to screen 1, and an "Export…" button (Phase 5).

**VERIFY Phase 4:** open a processed project. Confirm: overlay text changes as the video plays and matches the grid; clicking rows seeks; editing a translation persists after a full browser reload; dragging the waveform region visibly changes the row's times and persists; split/merge/delete/insert all work and survive reload; CPS turns red on a deliberately shortened line; bilingual toggle shows two rows in the overlay.

---

## 8. Phase 5 — Export (`app/exporter.py`)

`POST /api/projects/{id}/export` with body:

```json
{
  "kind": "mp4" | "srt" | "ass",
  "track": "translation" | "original" | "bilingual",
  "scope": "full" | "clips",
  "output_dir": "<absolute folder path, default = folder of the source video>"
}
```

Runs as a background job; `result.output_path` (or `output_paths` list for clip exports) is shown to the user with the file path when done.

### 8.1 SRT writer

Standard SRT: sequential index, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, text, blank line. `bilingual` = translation line then source line inside one cue. Write UTF-8 **with BOM** (`utf-8-sig`) — several Windows players misdetect plain UTF-8 SRT.

### 8.2 ASS writer

Generate a complete .ass file:

- `[Script Info]` with `PlayResX: 1920`, `PlayResY: 1080`, `WrapStyle: 0`, `ScaledBorderAndShadow: yes`.
- One `Default` style built from `ProjectStyle` (convert `#RRGGBB` → ASS `&H00BBGGRR&`; `Alignment: 2` for bottom, `8` for top; `MarginV` from style). For every distinct per-line override, emit an extra style named `Line_<line.id>` and reference it in that line's Dialogue row.
- Dialogue rows sorted by start; time format `H:MM:SS.cc` (centiseconds). Escape newlines in bilingual mode as `\N` (translation `\N` source, with the source wrapped in `{\fs<60% size>}` … no closing tag needed since the row ends).
- UTF-8 with BOM here too.

### 8.3 MP4 burn-in

1. Always generate the .ass first (styling burns exactly as the editor shows).
2. **Windows path gotcha (critical):** ffmpeg's `subtitles=` filter parses `:` and `\` specially, so `subtitles=C:\Users\...` fails. Solution: write the .ass as `burn.ass` inside the project folder and run ffmpeg with `cwd=projects/<id>/` and the plain relative filter `subtitles=burn.ass`. Do not attempt escape-sequence gymnastics.
3. Full export:
   `ffmpeg -y -i <ORIGINAL video abs path> -vf "subtitles=burn.ass" -c:v libx264 -preset medium -crf 18 -c:a copy <out>.mp4`
   (audio stream copied, not re-encoded; if `-c:a copy` fails because the container can't hold the codec, retry once with `-c:a aac -b:a 192k`).
4. `scope == "clips"`: export **one file per clip**, named `<stem>.clip01.mp4` etc. For each clip: shift a copy of the lines by `-clip.start` (drop lines entirely outside the clip, clamp lines that straddle its edges), write a per-clip .ass, then
   `ffmpeg -y -ss <start> -to <end> -i <original> -vf "subtitles=burn_clip01.ass" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k <out>.mp4`
   (**`-ss` after `-i`** would be frame-accurate but slow; use `-ss` before `-i` and accept keyframe snapping — with re-encoding it is still frame-accurate for the output. Keep `-ss/-to` before `-i` exactly as written.)
5. Progress: parse `-progress pipe:1` output from ffmpeg (`out_time_ms=` lines) against the expected duration and feed `report()`.

### 8.4 Export dialog (frontend)

Modal in the editor: radio kind (MP4 / SRT / ASS), radio track (translation / original / bilingual), scope radio shown only if the project has clips, output folder text field (prefilled with the source video's folder). On done, show the output path(s).

**VERIFY Phase 5:**
- Export SRT → open in a text editor: BOM present, times monotonic, bilingual has two text rows per cue.
- Export ASS → drop it plus the video into a player that supports ASS (e.g. MPC-HC/mpv/VLC): styles match the editor.
- Export MP4 (full) → subtitles are burned in, positioned/styled like the editor, audio intact.
- Mark a clip, export with `scope=clips` → the clip file's subtitles are correctly re-timed (a line visible at absolute 70 s in a clip that starts at 60 s must appear at 10 s in the output).

---

## 9. Settings (`settings.json` + settings UI)

On startup, create `settings.json` next to `run.py` if missing, with these defaults:

```json
{
  "llm_base_url": "https://api.openai.com/v1",
  "llm_api_key": "",
  "llm_model": "gpt-4o-mini",
  "pipeline": "two_stage",
  "asr_engine": "faster-whisper",
  "whisper_model": "large-v3",
  "whisper_device": "auto",
  "whisper_compute_type": "auto",
  "default_source_lang": "ja",
  "default_target_lang": "zh"
}
```

- `GET /api/settings` / `PUT /api/settings` (never return the full API key to the frontend — mask to last 4 chars; a submitted masked value means "unchanged").
- Screen 1 has a ⚙ settings modal editing all fields, plus a "Test connection" button that calls `POST /api/settings/test` → server does a 1-token chat completion and reports success/failure text. `asr_engine` is a two-option dropdown (faster-whisper / stable-ts); `whisper_model` is a dropdown with the §5.1 presets plus a free-text option. `pipeline` is NOT shown in the UI (single value today).
- If the pipeline is started with an empty API key, fail the job immediately with the message: `"No LLM API key set — open Settings (⚙) first."`

---

## 10. Error handling requirements

- Every background job wraps its body in try/except; on exception set `status="error"`, `error=str(e)` **plus the last executed external command if it was an ffmpeg failure** (include ffmpeg's stderr tail, last 30 lines).
- All ffmpeg invocations go through one helper `run_ffmpeg(args, cwd=None, on_progress=None)` in `ffmpeg_utils.py` that captures stderr and raises `FfmpegError` with it.
- LLM calls: catch connection/auth errors and surface a readable message ("LLM request failed: 401 Unauthorized — check your API key / base URL").
- The frontend shows job errors in a red banner with the message text, never a silent stall.
- Whisper model download (first run) can take minutes: report `message="Downloading whisper model (first run only)…"` before constructing `WhisperModel`.

---

## 11. Final acceptance checklist

Run through this end-to-end scenario on a real Japanese video before declaring the build complete:

1. `python run.py` → browser opens on screen 1.
2. Open ⚙, enter base URL/key/model, Test connection succeeds.
3. Paste video path → preview appears, seeking works.
4. Click "Translate whole video" → progress goes transcribing → translating → editor opens.
5. Lines are natural subtitle length (no wall-of-text lines), Chinese, correctly timed within ~0.3 s.
6. Fix one translation, retime one line via waveform, split one line, change global font size — all persist after browser reload.
7. Export MP4 → plays with burned styled subtitles. Export bilingual ASS → loads in mpv/VLC.
8. Back on screen 1, reopen the same project from the recent list → editor state intact.
9. New project on the same video, mark two clips, "Translate selected clips" → only clip audio is transcribed; export `scope=clips` produces correctly re-timed clip MP4s.

When every item passes, write a short `README.md` (how to install, configure settings, and run) and make the final commit.
