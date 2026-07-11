# Subtitler

Local subtitling tool: import a video, transcribe it with faster-whisper (or stable-ts),
split + translate with an LLM, fine-tune timing/text/styling in an Aegisub-style editor,
then export a burned-in MP4 or a standalone SRT/ASS file.

## Install

```
cd subtitler
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

Requires ffmpeg/ffprobe on PATH (`winget install Gyan.FFmpeg`).

## Run

```
.venv\Scripts\python run.py
```

Opens `http://127.0.0.1:8765` in your browser.

## Configure

Click **Settings ⚙** on the home screen:
- **LLM base URL / API key / model** — any OpenAI-compatible endpoint (OpenAI, DeepSeek,
  a local SakuraLLM/Qwen server via Ollama/LM Studio, etc). Use "Test connection" to verify.
- **ASR engine** — `faster-whisper` (default) or `stable-ts` (better on music/BGM sections,
  heavier install — pulls in PyTorch).
- **Whisper model** — `large-v3` (default), `medium`, or `kotoba-whisper` (Japanese-only,
  faster — requires source language `ja`).
- **Default source/target language** — defaults to Japanese → Simplified Chinese.

## Workflow

1. **Home** — paste a video path and click **Load video**. You land in the workspace
   immediately; import (probing, proxy build, audio extraction) finishes in the background —
   watch its progress on the **01 Clips** tab or read the live log on **Debug**. Leaving and
   coming back mid-import (via the recent list) resumes the progress view. Delete a project
   from the recent list with its **Delete** chip (removes the whole `projects/<id>` folder).
2. **01 Clips** — preview the video, optionally mark clips (`I`/`O` keys or drag on the
   waveform; the orange playhead tracks live playback). Click **Translate whole video**
   (default) or **Translate selected clips**.
   - Import is fast for sources that are already browser-safe: an H.264/AAC `.mp4` is served
     directly (no proxy at all); an H.264/AAC file in another container (e.g. `.mkv`) is
     remuxed in seconds; anything else is re-encoded (slower — the Debug log says so).
3. **02 Editor** — QC pass: fix translation text, retime lines (`[`/`]` + `Enter` to step
   through the whole video by keyboard, or drag waveform region edges — grab handles are
   sized for easy grabbing), split/merge/insert/delete lines. `Ctrl+Z`/`Ctrl+Y`
   (`Ctrl+Shift+Z`) undo/redo almost every edit (text, timing, style, drag-repositioning,
   image overlays). Zoom the waveform with the `−`/`+` buttons, `+`/`-` keys, or
   Ctrl+mouse-wheel; toggle a **Spectrogram** view under the waveform to see who's talking.
   - **Style rail** (right side of the editor) holds three expandable ribbons: **Global
     style** (font/size/colors/outline/margin/position for the whole project, plus the
     bilingual toggle), **Override — this line** (the same fields for just the selected
     line, with a **Reset to project style** chip), and **Speakers** (see below).
   - **Drag-to-position**: drag the subtitle directly on the video preview to reposition it
     (sets a custom `pos_x`/`pos_y`, bottom-center anchored, matching ASS `\pos`). Alt+drag
     repositions only the currently selected line instead of the whole project.
   - **Image overlays**: drop an image file onto the video preview to add it as an overlay —
     drag to move, use the corner handle to resize, hover for a delete button, and set its
     start/end time window in the row under the video. The editor preview is an HTML
     approximation, not a full compositor — the real composite (position, timing, and
     draw order under the subtitles) is what actually gets burned into MP4 exports.
   - If translation didn't fully succeed (bad API key mid-run, etc.), a banner explains why
     and offers **Retry translation**, which re-runs only the LLM step from the saved
     transcript (no re-transcription) once you've fixed Settings.
   - **Speakers**: for multi-speaker sources, open the **Speakers** ribbon on the style rail
     to add a named style preset per speaker (font/size/colors/position). Assign a line to a
     speaker from the **Speaker** dropdown in the inspector, or with `1`–`9` (assign speaker
     N) / `0` (clear to Default) on the selected line. The grid's **SPK** column shows each
     line's speaker as a colored dot + name. Lines from different speakers are allowed to
     overlap on screen (that's the point — people talking over each other); lines from the
     *same* speaker still can't — an overlapping Start cell is tinted orange, same as the
     CPS warning. Dragging a speaker-assigned subtitle on the video moves that speaker's
     position (all their lines move together — "this speaker lives in this corner");
     Alt+drag still repositions just the one line. Removing a speaker reverts its lines to
     the default style.
   Autosaves as you go.
4. **03 Export** — burned-in MP4 (subtitles + any image overlays, composited in the correct
   order via ffmpeg), or standalone SRT/ASS (original / translation / bilingual track, full
   video or per-clip). Speaker styling exports as real ASS styles (one `Spk_<name>` style
   per speaker used, with the speaker's name in the Dialogue `Name` field) and carries into
   burned MP4s; **SRT export stays plain text with no speaker markup**, by design.

The **Debug** tab (every screen) mirrors `projects/<id>/log.txt`, including the exact ffmpeg
commands run — copy it if something needs debugging.

See `manuals/BUILD_MANUAL.md`, `manuals/ITERATION_2.md`, and `manuals/ITERATION_3.md` for the
full technical spec.
