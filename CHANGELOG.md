# Changelog

All notable changes to the Subtitler app. Each entry names the panel it applies to —
**01 Clips**, **02 Editor**, **03 Export**, **Debug**, **Home** (project list / import screen),
**Settings**, or **Backend** (pipeline / server, no visible UI).

## v0.2.1 — 2026-07-10 (Clips-panel patch)

### Bug fixes

- **01 Clips** — Saved clips were invisible on the waveform after reloading a project (the
  data was stored correctly and transcription still worked; only the visualization was
  missing). Cause: regions were drawn before the audio finished decoding, so they landed on
  a zero-length timeline. Regions now render on the waveform's `decode` event.
- **02 Editor** — Same decode-race fixed for the initial line region when opening a project
  directly into the editor.

### New features

- **01 Clips** — Pressing `I` now stages a visible orange **IN marker** on the timeline; as
  you play on, the orange region grows with the playhead to show what you're capturing.
  `O` commits it as an aqua clip; `Esc` cancels the staged in-point. The summary label shows
  `IN at <time> — O commits · Esc cancels` while staging.
- **01 Clips** — Timeline panning: drag with the **right mouse button**, or press `←` / `→`
  to pan by a quarter viewport. Keyboard legend updated.

## v0.2.0 — 2026-07-10 (Iteration 2)

### Bug fixes

- **Home / 01 Clips** — After picking a video you couldn't go back and reselect. Import now
  jumps straight into the workspace and shows progress there; a `← Home` link is always
  available, import keeps running in the background if you leave, and the Load button no
  longer gets stuck disabled after a failed import.
- **01 Clips** — The playhead was invisible on the timeline (cursor width was 0). Now a 2 px
  orange cursor that tracks playback smoothly.
- **Backend** — Selecting the stable-ts engine crashed at transcription time (stable-ts ≥2.19
  renamed its patched method; our call hit the raw faster-whisper API with an unsupported
  `vad` argument). Fixed with a version-compatibility shim; engine/model load failures now
  land in the Debug log with full detail instead of a bare crash.
- **Backend** — An invalid LLM API key used to waste the entire transcription run before
  failing. The pipeline now makes a 1-token test call *first* and aborts within a second
  with a clear "fix Settings" message.
- **02 Editor** — (found during testing) A zoom-initialization crash could blank the whole
  editor tab with no visible error; and dragging the same image overlay twice silently
  edited a stale copy. Both fixed.

### New features

- **02 Editor** — "Retry translation" banner: when translation failed or was partial (e.g.
  bad API key), the editor shows the exact error and a button that re-runs *only* the
  LLM translation from the saved transcription — no re-dictation.
- **02 Editor** — Timeline zoom: `+` / `−` buttons, `Ctrl+wheel`, and `+`/`−` keys, with a
  px/s readout. Region edge handles are fatter and easier to grab. (Zoom also added to
  **01 Clips**.)
- **02 Editor** — Spectrogram toggle under the waveform, for telling speakers apart.
- **02 Editor** — Undo / redo (`Ctrl+Z` / `Ctrl+Y`) covering retimes, text edits,
  split/merge/insert/delete, style changes, and image overlay moves.
- **02 Editor** — Full styling: global panel (font with CJK suggestions, size, text color,
  outline color/width, position, vertical margin, bilingual toggle) plus per-line overrides
  with a reset chip. All of it flows into the ASS/MP4 export.
- **02 Editor** — Drag the subtitle directly on the video to reposition it; `Alt+drag`
  moves only the current line. Exported via ASS `\pos` tags so the burn matches the preview.
- **02 Editor / 03 Export** — Image overlays: drop a picture onto the video, drag/resize it,
  give it a time range; it is composited into the MP4 export with subtitles on top.
- **01 Clips** — Recent-project Delete buttons on the Home screen; per-clip title and note
  fields survive from v0.1 and now sit alongside the new import-progress panel.
- **Backend** — Smarter preview proxy: already-compatible MP4s skip transcoding entirely,
  H.264-in-MKV gets a fast remux, and only incompatible codecs pay the slow re-encode (the
  log now says which case you hit).
- **Backend** — Looser segmentation for Chinese output: up to 20 source words / 30 characters
  per line, "prefer complete sentences", "translation may be loose", plus a merge pass that
  absorbs sub-1.2-second fragments.
- **Debug** — Import logging now records the exact ffmpeg commands being run.

## v0.1.0 — 2026-07-09 (Iteration 1)

Initial build, per `BUILD_MANUAL.md`.

- **Home** — Paste a video path, import with progress, recent-projects list.
- **01 Clips** — Video preview (browser-safe proxy), waveform timeline with draggable clip
  regions, `I`/`O`/`J`/`L`/`Q`/`W`/`Space` keyboard marking, clip title/note table,
  "Translate whole video" (default) and "Translate selected clips" actions.
- **02 Editor** — Aegisub-style QC: video with live bilingual subtitle overlay, waveform
  retiming region, line grid with CPS warnings, inspector with time/text fields,
  split/merge/insert/delete, `[` `]` `Enter` `Q` `W` `R` `↑` `↓` keyboard timing, autosave.
- **03 Export** — Burned-in MP4 (ffmpeg, Windows-safe subtitle filter), SRT (UTF-8 BOM) and
  ASS writers, translation/original/bilingual tracks, full-video or per-clip scope.
- **Settings** — OpenAI-compatible LLM endpoint (base URL/key/model) with "Test connection",
  ASR engine choice (faster-whisper / stable-ts), whisper model presets incl. kotoba-whisper
  (Japanese-only guard), default language pair (ja → zh).
- **Debug** — Per-project `log.txt` mirrored in a console tab on every screen, with
  "Copy for Claude".
- **Backend** — faster-whisper word-level transcription (segment boundaries discarded),
  LLM re-segmentation + translation with word-index timestamps, validation/retry/rule-based
  fallback, background job system, range-served media, per-clip transcription with offset
  correction.
