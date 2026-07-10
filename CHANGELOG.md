# Changelog

All notable changes to the Subtitler app. Each entry names the panel it applies to —
**01 Clips**, **02 Editor**, **03 Export**, **Debug**, **Home** (project list / import screen),
**Settings**, or **Backend** (pipeline / server, no visible UI).

## v0.2.5 — 2026-07-10 (pending confirmation)

### Bug fixes

- **01 Clips / 02 Editor** — The waveform (and, on the editor tab, the spectrogram overlay)
  rendered nothing — no peaks, no `<canvas>` elements at all — despite audio decoding
  successfully (`WaveSurfer.getDuration()` was correct on both instances). Root cause: for the
  editor tab, `setupEditorTab()` calls `WaveSurfer.create()` on `#ed-track` while its panel is
  still `display:none` (the panel only becomes visible later, when `showTab()` first runs);
  WaveSurfer v7's renderer sizes and paints its canvases off the container's actual box via a
  `ResizeObserver`, and a `display:none` container has no box, so the very first paint pass
  never happens — and nothing afterward ever tells the renderer to try again, so the canvases
  stay empty forever even once the panel is shown. (There was in fact a previous, incomplete
  attempt at this exact fix already in `showTab()` — `edWs.setOptions && null` — which
  referenced the right method but never called it.) Confirmed by inspecting the WaveSurfer
  shadow DOM directly: zero `<canvas>` elements under `.wrapper` before the fix, and by
  confirming `edWs.setOptions({})` (a documented way to force a full re-render without
  reloading audio) immediately populated real, non-blank canvases. Fix: `showTab()` now calls
  `edWs.setOptions({})` once, the first time the editor tab is actually shown. The clips tab's
  `#track` was not actually broken by the same cause (its panel has no `display:none` at
  creation time and its container already has a real width when `WaveSurfer.create()` runs —
  confirmed by direct inspection, canvases paint correctly there on load); as a defensive
  measure `showTab()` applies the same one-time forced-redraw to the clips waveform too.

### New features

- **02 Editor** — The editor waveform (`#ed-track`) can now be panned exactly like the clips
  timeline: right-mouse drag, or `←`/`→` to pan by a quarter viewport. Added the matching
  shortcut rows to the editor keyboard legend.
- **02 Editor** — New right-side styling rail, mirroring the left shortcut sidebar, visible
  only on the editor tab. It holds two independently expandable ribbons — **"Global style —
  all lines"** (moved out of the old collapsible panel below the waveform) and **"Override —
  this line"** (moved out of the inspector) — so the inspector now holds only start/end,
  translation/original text, and the line action chips. Global defaults to expanded, Override
  to collapsed; each ribbon's open/closed state persists across reloads via `localStorage`.
  The rail hangs beyond the body's right edge (the page widens to make room), so the main frame keeps its full width instead of being squeezed.
  The `Ctrl+Z` undo and `Ctrl+Y` / `Ctrl+Shift+Z` redo shortcuts, previously one combined row
  in the sidebar, are now listed as two separate rows.

## v0.2.4 — 2026-07-10 (editor patch)

### Bug fixes

- **01 Clips / 02 Editor** — Switching between the Clips and Editor tabs left the previous
  tab's video playing in the background. `showTab()` now pauses both video elements
  unconditionally on every switch — no auto-resume.
- **02 Editor** — Dragging the subtitle overlay on the video intermittently glitched/jumped
  by a few pixels for a few frames. Cause: `updateOverlay()` runs on both a 100 ms interval
  and video `timeupdate`, and was rebuilding the overlay's innerHTML and re-applying its
  saved position *while* the drag handler was writing live positions — the two fought each
  other. `updateOverlay()` now no-ops entirely while a drag is in progress, and separately
  skips its DOM write whenever the line/text/style/position state hasn't changed since the
  last render, removing incidental flicker and text-selection loss too. The drag and the
  overlay renderer now also write position through the identical `left`/`bottom`/`transform`
  properties, so there's no unit-mismatch jump on drop.
- **02 Editor** — The subtitle outline previously faked itself with a 4-direction
  `text-shadow`, leaving visible gaps at diagonal glyph edges. Replaced with a proper stroke
  using a duplicated-layer technique (a back copy drawn with `-webkit-text-stroke`, a front
  fill copy on top), which fully surrounds glyphs including diagonals, respects per-line
  outline-color overrides, and applies identically in positioned, default bottom/top, and
  bilingual modes. Preview-only — export already uses libass's real outline rendering.

### New features

- **02 Editor** — New **"+ New line at playhead"** chip (and `N` shortcut) creates a blank
  1.5 s line at the video playhead — no existing selection required, and it works even when
  the project has zero lines. If the playhead already sits inside a line, the new line is
  inserted immediately after that line's end instead. Duration is clamped so it never
  overlaps the next line's start. The new line is inserted at the correct chronological
  position, selected, and its translation field is focused so typing can start immediately.

## v0.2.3 — 2026-07-10 (double-click launcher)

### New features

- **App** — Double-click launcher (`subtitler/Launch-Subtitler.bat`): starts the app and
  opens the browser with one click, no terminal needed. On the very first run it sets up its
  own environment (creates the virtualenv and installs dependencies); afterwards it launches
  straight away. Warns if Python or ffmpeg are missing. The console window it opens doubles
  as the on/off switch — close it to stop the app. A `.gitattributes` rule keeps `.bat`
  files at CRLF line endings so Windows parses them correctly.

## v0.2.2 — 2026-07-10 (shortcut-sidebar layout)

### New features

- **01 Clips / 02 Editor** — The keyboard-shortcut legend now sits in a distinct, sticky left
  appendix rather than inside the workspace frame. It preserves the frame's original structure,
  aligns its key and description columns, swaps its content for the active tab, and disappears
  entirely on Export/Debug. On narrow screens it moves below the workspace so editing remains
  usable.

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
