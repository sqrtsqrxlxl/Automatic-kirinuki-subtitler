# Subtitler — Iteration 2 Work Orders

You are an implementation agent. The app already exists in `subtitler/` and was built from
`subtitler/manuals/BUILD_MANUAL.md` (read it first for architecture, data model, file layout, and coding rules —
all of its "Rules for you, the agent" still apply). This document lists the changes for
iteration 2, based on user testing. Work through the items **in order**; each has a VERIFY
section. Commit per item if git is initialized; otherwise skip committing.

Environment facts: Windows 11; venv interpreter at `subtitler/.venv/Scripts/python.exe`;
ffmpeg/ffprobe on PATH; server runs at `http://127.0.0.1:8765` via
`subtitler/.venv/Scripts/python.exe subtitler/run.py` (or uvicorn with `--app-dir subtitler`).
To test the API without a browser, use `curl`. To seed test data with Chinese text, write a
small Python script that calls the API with `urllib` (do NOT pipe Chinese through the
terminal/curl — the Windows codepage corrupts it; this was learned the hard way).

---

## I2-1 · Import flow: go back, cancel, delete, and see what's happening

**Problems reported:** (a) once a video is selected there's no way to go back and pick a
different one; (b) the import progress bar doesn't explain what the program is doing.

**Fix — move import progress into the workspace and make everything escapable:**

1. In `screen1.js`: after `POST /api/projects` returns, **immediately** navigate to
   `workspace.html?project=<id>&tab=clips` — do NOT wait for the import job to finish on
   index.html. Pass the import job id along: `&import_job=<job_id>`.
2. In the workspace clips tab: if `import_job` is present in the URL (or `project.status ==
   "importing"`), hide the video/timeline area and show the progress panel with the job's
   live `message` (the backend already emits step-by-step messages: probing → building proxy
   → extracting audio). When the job completes, reload the project and initialize the tab
   normally. The **Debug tab must work during import** — it already polls the per-project
   log, which records every step; this answers "what is it doing".
3. Add a visible `← Home` link in the workspace masthead next to the wordmark (the wordmark
   is already a link, but make it explicit text so the user knows they can leave anytime).
4. On index.html: never leave the Load button permanently disabled — re-enable it whenever
   the POST fails AND after navigating away is aborted. Add a **Delete** button (small
   `style-chip`) on each recent-project row. Backend: add `DELETE /api/projects/{id}` which
   removes the whole `projects/<id>` folder (use `shutil.rmtree`); the frontend confirms
   with `confirm()` first, then refreshes the list.
5. Import log detail: in `main.py`'s `do_import`, before each ffmpeg call also
   `logger.log(...)` the **exact ffmpeg arguments** being run, so the Debug tab shows the
   real commands.

**VERIFY:** import a video → you land in the workspace immediately with a moving progress
message; the Debug tab shows the probe/proxy/audio steps live; clicking `← Home` mid-import
works, and the import continues in the background (recent list shows the project with status
`importing`, opening it resumes the progress view). Delete a project from the recent list and
confirm its folder is gone.

## I2-2 · Preview proxy is slow — skip re-encoding when possible

**Problem:** the proxy build re-encodes every video even when the source is already
browser-compatible.

**Fix** in `ffmpeg_utils.py` + `main.py`:

1. Extend `probe()` to also return the **video codec name, audio codec name, and container**
   (`codec_name` for `v:0` and `a:0`; container from the file extension).
2. Decision ladder for the proxy step:
   - video is `h264` AND audio is `aac` AND extension is `.mp4` → **no proxy at all**: serve
     the original file directly. Store `proxy: false` on the project (add field
     `has_proxy: bool = True` to the model) and make the preview endpoint serve
     `project.video_path` when `has_proxy` is false.
   - video is `h264` AND audio is `aac` but container is not mp4 (e.g. mkv) → **remux only**:
     `ffmpeg -i in -c copy -movflags +faststart preview.mp4` (seconds, not minutes).
     Log: `"remuxing (fast, no re-encode)"`.
   - anything else → re-encode as today, but log
     `"re-encoding for browser compatibility — this is the slow step"` so the user knows why.
3. If video height ≤ 720 in the re-encode case, drop the `scale` filter (don't upscale).

**VERIFY:** import an H.264/AAC .mp4 → import completes in a few seconds, log says the proxy
was skipped, and the video still plays and seeks in the browser. Import an h264 .mkv if one
is available (or create one: `ffmpeg -i test.mp4 -c copy test.mkv`) → log says "remuxing".

## I2-3 · Playhead invisible on the clips timeline

**Problem:** there is no visible position marker on the interface-1 waveform.

**Fix:** in `workspace.js`, the clips-tab WaveSurfer is created with `cursorWidth: 0`.
Change both WaveSurfer instances to `cursorWidth: 2, cursorColor: "#FF5C1F"`. Also verify the
cursor moves during playback: the existing `timeupdate` sync only fires ~4×/sec; add a
`requestAnimationFrame` loop (or 100 ms interval) while the video is playing that calls
`ws.setTime(videoEl.currentTime)` (v7 API; falls back to `seekTo(t/duration)` if `setTime`
is absent) so the cursor tracks smoothly. Guard against loops with the existing 0.25 s
epsilon on the reverse direction.

**VERIFY:** play the video on the clips tab — an orange cursor visibly travels along the
waveform; clicking the waveform still seeks the video.

## I2-4 · stable-ts and kotoba-whisper crash

**Problem:** selecting stable-ts (and kotoba-whisper) threw an error at transcription time.

**Root-cause guidance:** in stable-ts 2.19, `load_faster_whisper()` does NOT replace
`.transcribe()` — the patched, silence-aware method is **`.transcribe_stable()`** (depending
on version). Calling `.transcribe(vad=True)` therefore hits the ORIGINAL faster-whisper
method, which has no `vad` kwarg → `TypeError: unexpected keyword argument 'vad'`.

**Fix** in `transcribe.py` `StableTsTranscriber.transcribe`:

```python
fn = getattr(self.model, "transcribe_stable", None) or self.model.transcribe
try:
    result = fn(audio_path, language=lang or None, word_timestamps=True, vad=True)
except TypeError:
    # this build's method doesn't take stable-ts kwargs — plain call
    result = fn(audio_path, language=lang or None, word_timestamps=True)
```

Also wrap BOTH engines' model loading and transcribe calls so any exception is logged to the
project log with the full `repr(e)` **and the engine+model names** before re-raising — the
user must be able to open the Debug tab and read exactly what failed. Then actually test the
stable-ts engine end-to-end (see VERIFY). For kotoba: it is a CT2 conversion of
distil-large-v3; it must be loaded through the normal `WhisperModel(repo_id)` path. If
loading it inside stable-ts fails, catch that and surface:
`"stable-ts could not load <model>: <err> — try the faster-whisper engine for this model."`

**VERIFY (mandatory, not optional):** create a short speech WAV (PowerShell
`System.Speech.Synthesis` — see BUILD_MANUAL verification approach), mux to mp4, import it,
set `asr_engine` to `stable-ts` with model `medium` (small download) in settings.json, run
the pipeline with a deliberately-empty API key project… actually the pipeline aborts early
without a key after I2-5 — so instead call the transcriber directly with a throwaway script:
`python -c "..."` that loads settings, builds `StableTsTranscriber`, and transcribes the
test wav. It must return a non-empty word list with sane timestamps. Repeat once with
`faster-whisper` engine to prove no regression.

## I2-5 · Invalid API key: fail fast, and add a "Retry translation" button

**Problems reported:** with a bad key the pipeline burned minutes on transcription, then
produced untranslated lines; the user wants (a) to be told about the bad key up front, and
(b) a button to re-run ONLY the translation after fixing credentials — without
re-transcribing.

**Fix:**

1. **Fail fast:** at the very start of the pipeline job (in `pipeline.py`, before
   transcription), make a 1-token test call to the LLM (same code as `/api/settings/test`).
   If it fails, raise
   `ValueError(f"LLM connection failed before starting: {e} — fix Settings (⚙) and start again.")`
   so no whisper time is wasted. Log it.
2. **Track translation health:** add `translation_status: str = "ok"` to the `Project`
   model (`"ok" | "failed" | "partial"`). In `translate.py`, count fallback chunks; if ALL
   chunks fell back set `"failed"`, if some `"partial"`, else `"ok"`. Include the last LLM
   error string in a new field `translation_error: str = ""`. Save both.
3. **Editor banner + retry:** in the editor tab, if `project.translation_status != "ok"`,
   show a banner (reuse `.err-banner`) above the grid:
   `"Translation incomplete: <translation_error>. Fix your API settings, then retry."`
   with a **Retry translation** button beside it. The button calls the EXISTING
   `POST /api/projects/{id}/retranslate` endpoint (it re-runs segmentation+translation from
   the saved `words.json` — no transcription), polls the job with the standard progress UI,
   and reloads the page when done. Warn via `confirm()` that retrying replaces all current
   lines (manual edits included).
4. The banner must also appear right after a pipeline finishes in this state (it will, since
   the editor loads the fresh project).

**VERIFY:** set an invalid API key → start pipeline → it fails within seconds with the
"LLM connection failed before starting" message (no transcription happened — check the log).
Then simulate the partial case: temporarily hack `translation_status` to `"failed"` in a
project.json → editor shows the banner; the Retry button hits `/retranslate` and the error
path (still-bad key) surfaces in the progress area.

## I2-6 · Segmentation too fine — longer, looser lines

**Problem:** output is chopped into too many small pieces. Target is Chinese; the user is
fine with looser correspondence to the Japanese.

**Fix** in `translate.py`:

1. Rewrite the two hard limits in `SYSTEM_PROMPT`: a line may cover at most **20 words** of
   source text and its translation at most **30 characters**; add these instructions:
   - `Prefer COMPLETE sentences. Never split a sentence across lines unless its translation would exceed the character limit.`
   - `Prefer fewer, longer lines over many short fragments. Merge short interjections into the neighbouring line when natural.`
   - `The translation may be loose: prioritise natural {tgt_lang_name} phrasing over word-for-word correspondence with the source.`
2. Keep index-contiguity rules unchanged (they are what makes timestamps reliable).
3. Post-process merge pass (after `_postprocess`, new function `_merge_fragments`): while any
   line has duration < 1.2 s AND its gap to the next line is < 0.2 s AND
   `len(line.text_tgt + next.text_tgt) <= 30`, merge it into the next line (concatenate
   src with a space, tgt without separator, keep first start / second end). Iterate until
   stable. Log how many merges happened.

**VERIFY:** unit-test the merge pass directly with a hand-built list of `Line` objects
(short fragments + normal lines) via a `python -c` script; assert the fragment count drops
and no timestamps overlap. The prompt change is verified by inspection (print the final
rendered system prompt).

## I2-7 · Editor timeline: zoom + easier edge dragging

**Fix** in the editor tab (`workspace.js` / `workspace.html` / `app.css`):

1. **Zoom:** add `minPxPerSec` handling via `edWs.zoom(px)`. Controls: small `−` / `+`
   buttons and a readout (e.g. `40 px/s`) in an eyebrow row above the waveband, plus
   **Ctrl+mouse-wheel** over the waveband (preventDefault, multiply/divide by 1.3, clamp
   10–500 px/s). WaveSurfer v7 auto-scrolls; confirm `autoScroll: true` and
   `autoCenter: true` options are set at create time.
2. Apply the same zoom mechanism to the clips-tab waveform (shared helper function).
3. **Fatter region handles:** WaveSurfer v7 region handles are styleable via CSS `::part`:
   ```css
   #ed-track ::part(region-handle-left), #ed-track ::part(region-handle-right) {
     width: 10px; border-color: var(--aqua); background: color-mix(in srgb, var(--aqua) 55%, transparent);
   }
   ```
   Do the same for `#track` (clips). If `::part` doesn't take effect, fall back to setting
   the `handleStyle` region option if the plugin build supports it — check the vendored
   `regions.min.js` for `handleStyle` before assuming.
4. New keyboard shortcuts (editor): `+` / `-` zoom in/out. Add them to the keyboard legend.

**VERIFY:** in the browser (preview tools or manual eval): zoom in until individual words are
visible, waveform scrolls to keep the cursor centered while playing; drag a region edge —
the fatter handle is grabbable at the first attempt; `project.json` shows the retimed value.

## I2-8 · Spectrogram view (who is talking)

**Fix:**

1. Download `https://unpkg.com/wavesurfer.js@7/dist/plugins/spectrogram.min.js` into
   `static/vendor/` (curl, then sanity-check it's real JS ≥ 10 KB, not an error page).
2. Editor tab: add a `Spectrogram` toggle chip in the eyebrow row above the waveband. On
   first enable, register the plugin on the EXISTING `edWs` instance:
   `edWs.registerPlugin(WaveSurfer.Spectrogram.create({ height: 100, labels: false }))`
   (check the UMD global name inside the vendored file — it may be
   `WaveSurfer.Spectrogram` or a standalone `Spectrogram` global — adapt accordingly).
   On disable, call the plugin's `destroy()`. Keep a reference; re-enable re-creates it.
3. The spectrogram renders in its own sub-container below the waveform inside `#ed-track`
   (the plugin appends itself); let the waveband grow (`height: auto; min-height: 72px`).

**VERIFY:** toggle on → a spectrogram appears under the waveform and scrolls/zooms with it;
toggle off → it disappears; no console errors either way.

## I2-9 · Undo / redo in the editor

**Fix** in `workspace.js`:

1. One undo stack for the editor: snapshots of `{lines, style}` as
   `JSON.parse(JSON.stringify(...))`, max 100 entries, plus a redo stack.
2. `pushUndo()` is called BEFORE every mutation: inspector time/text commits, `[`/`]`
   retimes, region-drag commit (`region-updated` end — debounce so one drag = one snapshot;
   use the regions plugin's `region-update-end`-equivalent event if present, else push on
   the first `region-updated` of a burst), split / merge / insert / delete, style changes,
   overlay drag (I2-10).
3. `Ctrl+Z` = undo (pop → apply → push onto redo stack); `Ctrl+Y` or `Ctrl+Shift+Z` = redo.
   Apply = replace `project.lines`/`project.style`, re-render table + overlay + region +
   inspector, `scheduleAutosave()` + `scheduleStyleSave()`.
4. These bindings live in `onEditorKeydown` but must ALSO fire when focus is in an
   input/textarea? No — keep the existing guard (inputs keep native undo); document that.
5. Add `Ctrl+Z undo · Ctrl+Y redo` to the keyboard legend.

**VERIFY:** delete a line → Ctrl+Z restores it (and the grid re-renders); retime with `[`,
Ctrl+Z reverts the time; Ctrl+Y re-applies. Confirm autosave fires after undo (check
project.json).

## I2-10 · Full subtitle styling + drag-to-position

**Problems:** no font/size/color/border editing; no way to change position precisely.

**Fix:**

1. **Model:** extend `ProjectStyle` and `StyleOverride` with `pos_x: float | None = None`,
   `pos_y: float | None = None` (fractions 0–1 of frame width/height; the anchor is the
   BOTTOM-CENTER of the subtitle block, matching ASS `\an2`). `None` = classic
   bottom/top + margin behaviour.
2. **Global style panel** (editor tab, collapsible section between inspector and waveband,
   heading eyebrow `Style — applies to every line`): font (text input with a `datalist` of
   common CJK-capable fonts: Microsoft YaHei, SimHei, Noto Sans CJK SC, Yu Gothic, Meiryo,
   MS Gothic, Arial), size (number), text color + outline color (`<input type=color>`),
   outline width (number 0–6), position dropdown (bottom / top / custom), margin_v
   (number), bilingual toggle (move the existing chip here). All changes: live overlay
   update + debounced PATCH (the plumbing exists — `scheduleStyleSave`).
3. **Per-line overrides** in the inspector: same fields but nullable, prefixed with a
   `Override` eyebrow and a `Reset to project style` chip that nulls the line's `style`.
   Overlay + ASS export must respect overrides (exporter already emits per-line styles —
   extend it for the new fields; per-line `\pos` goes into the Dialogue text as an override
   tag: `{\an2\pos(x*1920,y*1080)}`).
4. **Drag-to-position:** make the overlay div interactive (`pointer-events: auto`,
   `cursor: grab`). On pointerdown+move, track the pointer within the video element's
   bounding box and set `pos_x = clamp(px / videoWidth, 0.02, 0.98)`,
   `pos_y = clamp(py / videoHeight, 0.05, 0.98)`; while dragging, apply visually; on
   pointerup, commit: if the drag started with Alt held OR a per-line override already has
   a position, write to the LINE's override, else to the GLOBAL style; `pushUndo()` first;
   save. Show a hint under the video: `Drag the subtitle to reposition · Alt+drag = this line only`.
5. **Overlay rendering with pos:** when `pos_x/pos_y` set, position with
   `left: pos_x*100%; transform: translateX(-50%); bottom: (1-pos_y)*100%` on the overlay
   (with the existing font scaling). When null, keep current bottom/top behaviour.
6. **ASS export:** global custom position → put `\pos` override tag on every Dialogue row
   that doesn't have its own (ASS has no per-style \pos; tags are the correct mechanism).
   Coordinates: `round(pos_x*1920)`, `round(pos_y*1080)` with `\an2`.

**VERIFY:** change font size/color globally → overlay updates live and project.json holds
the values. Drag the subtitle to the top-left → overlay sticks there; export .ass → the
Dialogue rows carry `\pos(...)` with plausible coordinates; burn a short MP4 and extract a
frame (`ffmpeg -ss ... -frames:v 1`) — the text sits at the dragged position. Alt+drag one
line → only that row gets the tag.

## I2-11 · Image overlays (drag a picture in, burn it into the export)

**Fix:**

1. **Model:** new `ImageOverlay(BaseModel)`: `id: str`, `filename: str`,
   `x: float = 0.05`, `y: float = 0.05` (top-left, fractions), `width: float = 0.3`
   (fraction of frame width; height auto from aspect), `start: float = 0`,
   `end: float | None = None` (None = until video end). `Project.images:
   list[ImageOverlay] = []`.
2. **Endpoints:** `POST /api/projects/{id}/images` accepts multipart upload (fastapi
   `UploadFile`; require `python-multipart` — add to requirements and pip install), saves to
   `projects/<id>/images/<uuid8>.<ext>` (png/jpg/webp only), appends an `ImageOverlay`,
   returns the project. `GET /api/projects/{id}/images/{filename}` serves the file.
   `DELETE /api/projects/{id}/images/{image_id}` removes entry + file. PATCH already
   handles arbitrary top-level keys — add `images` to its allowed list.
3. **Editor UI:** dropping an image file onto the video well (dragover/drop handlers,
   `DataTransfer.files`) uploads it. Each overlay renders as an absolutely-positioned
   `<img>` over the video (same coordinate math as the subtitle overlay), draggable
   (pointer events, commit on pointerup → PATCH), resizable via a small corner handle
   (drag changes `width`). A small `×` button on hover deletes it. Also show `start`/`end`
   inputs for the selected image in a thin row under the video (click an image to select).
   All mutations `pushUndo()` (include `images` in undo snapshots).
4. **Export burn-in** (`exporter.py`): when `project.images` is non-empty, build a
   `-filter_complex` chain instead of the plain `-vf`:
   ```
   ffmpeg -i video -i img1.png -i img2.png -filter_complex
     "[1:v]scale=W1:-1[i1];[0:v][i1]overlay=X1:Y1:enable='between(t,S1,E1)'[v1];
      [2:v]scale=W2:-1[i2];[v1][i2]overlay=...[v2];
      [v2]subtitles=burn.ass[vout]" -map "[vout]" -map 0:a ...
   ```
   where `W = round(width*frame_w)`, `X = round(x*frame_w)`, `Y = round(y*frame_h)`,
   `E = end or video_duration`. Subtitles ALWAYS render last (on top). Clip export: shift
   `start`/`end` by the clip start and drop overlays fully outside the clip. Remember the
   `cwd=project_dir` trick still applies for the `subtitles=` filter; image paths in
   `-i` can be absolute (only the subtitles filter has the Windows path parsing problem).
5. The preview overlay is an approximation (HTML `<img>`), which is fine — the editor is not
   a compositor. Document that in the README.

**VERIFY:** drop a PNG onto the video → it appears, drags, resizes, persists after reload
(check project.json + the images folder). Export MP4 → extract a frame inside the overlay's
time window: image is composited at the right spot with subtitles on top. Delete the overlay
→ next export has no image.

## I2-12 · README + keyboard legend updates

Update `subtitler/README.md` and the on-screen keyboard legends for everything added:
zoom (`+`/`-`, Ctrl+wheel), undo/redo, Alt+drag subtitle, image drop, spectrogram toggle,
Retry translation. Keep the tone/format of the existing README.

## I2-13 · Regression sweep (mandatory before declaring done)

Re-run the essentials of BUILD_MANUAL §11 that don't need an API key:

1. Fresh import (delete old test projects first) → workspace progress → clips tab OK.
2. `I`/`O` clip marking, clip notes table, delete clip, playhead visible.
3. Seed lines via a Python script (UTF-8!), editor: select/retime/split/merge/undo, style
   panel, drag-position, image overlay.
4. Export SRT (BOM), ASS (spot-check `\pos` tags), MP4 burn (extract a frame and LOOK at it).
5. `python -c "import app.main"` passes; no stray test artifacts left in `subtitler/`
   (remove seed scripts, test videos, test output folders, and reset `settings.json` and
   `projects/` to clean state at the very end).

Definition of done: every VERIFY in I2-1 … I2-11 executed and passing, regression sweep
clean, README updated.
