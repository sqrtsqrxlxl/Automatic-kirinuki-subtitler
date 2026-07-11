# Subtitler — Iteration 3 Work Orders (Speakers + editor polish)

You are an implementation agent. The app exists in `subtitler/` — read
`subtitler/manuals/BUILD_MANUAL.md` §"Rules for you, the agent" first (all rules apply),
and `subtitler/manuals/DESIGN_LANGUAGE.md` for the visual language (Swiss Modernism 2.0,
violet/lilac structure, orange actions, aqua highlights, NO blue). Work the items in
order; each has a VERIFY section. Do not commit to git.

Environment: Windows 11; venv at `subtitler/.venv/Scripts/python.exe`; server on port
8765 (`.claude/launch.json` config "subtitler"); test project `claude-test-video-2400b0`
exists under `subtitler/projects/`. NEVER pipe Chinese/Japanese through the terminal —
seed test data with UTF-8 Python scripts using urllib.

Relevant code: `subtitler/app/models.py` (Line, StyleOverride, ProjectStyle, Project),
`subtitler/app/main.py` (PATCH allowed keys), `subtitler/app/translate.py`
(`_postprocess`, `_merge_fragments`), `subtitler/app/exporter.py` (`write_ass`,
`_effective_pos`), `subtitler/static/js/workspace.js` (inspector, `updateOverlay()`,
`effectiveStyle()`, `createNewLineAtPlayhead()`, overlay drag, undo snapshots, style
rail with `rail-ribbon` sections), `workspace.html`, `css/app.css`.

---

## I3-1 · Remove the stray white margin under the translation/original textareas

**Problem:** in the editor inspector there is a small white gap below each textarea.
**Root cause to verify:** `<textarea>` is inline-block, so it sits on the text baseline
and leaves a descender gap below it inside `.field`.
**Fix:** `.inspector textarea.fval, .field textarea { display: block; }` (or
`vertical-align: top`) — verify in the browser that the gap under BOTH textareas is
gone and nothing else shifted.

## I3-2 · Make the line-action chips intuitive (icons + color + sentence case)

**Problem:** the five chips (Split at playhead / Merge ↓ / Insert after / + New line at
playhead / Delete) are uppercase micro-text — unreadable at a glance.

**Fix** (in `workspace.html` + `app.css`):
1. New class `action-chip` (extends `.style-chip` styling but: `text-transform: none;
   letter-spacing: 0.02em; font-size: 12px;` — sentence case, readable).
2. Each chip gets a leading icon and a `title` tooltip with a fuller sentence:
   - `✂️ Split` — title "Split this line in two at the video playhead"
   - `🔗 Merge` — title "Merge this line with the next one"
   - `➕ Insert` — title "Insert a new empty line right after this one"
   - `⏱️ New at playhead` — title "Create a new empty line at the video playhead (N)"
   - `🗑️ Delete` — title "Delete this line"
3. Color coding, quiet Swiss style (tint border + text, not filled):
   creation chips (`➕`, `⏱️`) aqua (`--aqua` border / `--aqua-ink` text); `🗑️ Delete`
   orange; `✂️`/`🔗` stay neutral ink-2. Hover keeps the existing lilac wash.
4. Keep every existing id (`split-btn` etc.) so JS bindings are untouched.

**VERIFY:** screenshot the inspector — icons render (Windows Chrome/Edge render these
emoji natively), labels are sentence case, delete reads orange, create-chips read aqua.

## I3-3 · Speakers — data model + API

The v3.0-roadmap feature, pulled forward. A speaker is a named style preset; a line
belongs to at most one speaker; unassigned lines use the project default style.

1. `models.py`:
   ```python
   class Speaker(BaseModel):
       id: str                      # uuid4().hex[:8]
       name: str                    # "Speaker A" etc., user-editable
       style: StyleOverride = Field(default_factory=StyleOverride)
   ```
   - `Project.speakers: list[Speaker] = []`
   - `Line.speaker_id: str | None = None`
2. `main.py`: add `"speakers"` to the PATCH allowed-keys list. Lines already round-trip
   through PUT /lines (pydantic picks up the new optional field automatically — verify).
3. **Style resolution order (single source of truth, used by overlay AND export):**
   line override > speaker preset > project style, **per field**. Frontend: extend the
   existing `effectiveStyle()` helper to take the line, look up its speaker, and layer
   the three. Backend export: same layering in `write_ass` (see I3-7).
4. Deleting a speaker sets `speaker_id = None` on every line that referenced it (do
   this client-side in the delete handler, then save lines + speakers).

**VERIFY:** PATCH a project with two speakers via a UTF-8 Python script; PUT lines with
`speaker_id` set; GET returns both intact; old projects (no `speakers` key) still load.

## I3-4 · Speakers — UI

1. **Style rail, third ribbon "Speakers"** (after Global and Override, same
   `rail-ribbon` pattern, collapsed by default, state persisted like the others):
   - One row per speaker: color dot (speaker's effective text color), editable name
     input, expand/collapse chevron revealing the preset fields (font + datalist, size,
     text color, outline color, position dropdown bottom/top/custom), and a small
     `🗑️` remove button (confirm() first; reverts its lines to default per I3-3.4).
   - `➕ Add speaker` button at the bottom — creates "Speaker A/B/C…" with a distinct
     default text color per index (pick 6 rotating colors that fit the palette, e.g.
     white, aqua #35D9C0, lilac #CDB9F2, orange #FF8A55, yellow #FFD166, green #8AE07A
     — subtitle colors on video, not UI chrome, so palette rules relax here).
   - All edits: live overlay update + debounced PATCH of `speakers` + `pushUndo()`
     (include `speakers` in undo snapshots and `applySnapshot`).
2. **Inspector: speaker assignment** — a `Speaker` dropdown above the action chips:
   `Default` + one option per speaker. Changing it sets the selected line's
   `speaker_id`, pushes undo, autosaves, re-renders overlay + grid.
3. **Keyboard:** in `onEditorKeydown`, digits `1`–`9` assign the Nth speaker to the
   selected line, `0` clears to Default. Add one row to the editor shortcut sidebar:
   `1–9 / 0` — "assign speaker N / clear speaker".
4. **Grid:** new narrow column `SPK` between `#` and `Start`: a colored dot +
   speaker name (truncate ~8 chars) for assigned lines, empty for default. Dot color =
   speaker's effective text color.
5. **Overlay drag routing** (extends the existing drag): plain drag on a line that HAS
   a speaker → writes `pos_x/pos_y` to that SPEAKER's preset (all their lines move —
   that's the point of "this speaker lives in this corner"); Alt+drag → line override
   (unchanged); plain drag on a default line → global style (unchanged). Update the
   drag-hint text under the video accordingly.

**VERIFY (browser):** create 2 speakers with different colors/positions; assign lines
via dropdown AND via digit keys; grid shows dots; renaming a speaker updates the grid
and dropdown; deleting a speaker reverts its lines; undo restores a deleted speaker;
everything persists after reload (check project.json).

## I3-5 · Overlay: render ALL simultaneously-active lines with their speaker styles

**Problem:** `updateOverlay()` renders only the FIRST line covering the current time.
With speakers, two lines can legitimately be on screen at once.

**Fix:**
1. Collect ALL lines where `start <= t < end` (they're sorted; a simple filter is fine).
2. Render each as its own block with its resolved style (I3-3.3), including the stroke
   layers from v0.2.4 and bilingual mode.
3. Placement: lines with explicit `pos_x/pos_y` (from any layer) render at their
   position. Lines without stack in their anchor group — bottom-anchored lines stack
   upward from the bottom margin, top-anchored stack downward (a flex column per
   anchor is the simple way).
4. Update the render-cache key (`lastOverlayRenderKey`) to hash ALL active line ids +
   texts + resolved styles, so multi-line states re-render correctly and the
   drag-suppression flag keeps working.

**VERIFY (browser):** seed two overlapping lines assigned to two speakers with
different colors + positions; seek into the overlap; BOTH render simultaneously with
their own styling (screenshot); non-overlapping times still show one line; dragging
still works per the I3-4.5 routing.

## I3-6 · Overlap rules become per-speaker

**Rule (user's spec):** within one speaker (including Default), lines must not overlap
— that protection already exists globally and should stay. ACROSS different speakers,
overlap is allowed and normal.

1. `translate.py` `_postprocess` and `_merge_fragments`: group lines by `speaker_id`
   first and apply the existing min-duration / gap-snap / de-overlap / merge logic
   within each group only. (Pipeline output has no speakers, so behavior today is
   identical — this future-proofs re-runs on speaker-tagged projects.)
2. `createNewLineAtPlayhead()` (workspace.js): the "clamp against next line" and
   "dodge to after the covering line" logic must consider only lines of the SAME
   speaker the new line will have (new lines are Default → clamp against Default
   lines only).
3. `PUT /lines` validation (main.py): currently rejects `end <= start` per line — do
   NOT add global overlap rejection (cross-speaker overlap is now legal).
4. **Grid QC warning:** when a line overlaps the previous line of the SAME speaker,
   tint its Start cell orange (like the CPS warning) with a `title` explaining it.
   Cross-speaker overlap gets no warning.

**VERIFY:** unit-test `_postprocess` grouping via a `python -c` script (two speakers
with interleaved overlapping lines → same-speaker overlaps clamped, cross-speaker
overlaps preserved). In the browser: same-speaker overlap shows the orange Start cell;
cross-speaker overlap doesn't.

## I3-7 · Export: speakers become real ASS styles

1. `write_ass` (exporter.py): emit one ASS `Style: Spk_<sanitized-name>` per speaker
   that has ≥1 line in the export, built by layering speaker preset over project style
   (same field resolution as I3-3.3). Dialogue rows of assigned lines use that style
   name and put the speaker's name in the Dialogue `Name` field. Speaker `pos_x/pos_y`
   → `{\an2\pos(...)}` tag on those rows (existing `_effective_pos` grows a speaker
   layer: line override > speaker > global).
2. Per-line overrides keep winning exactly as today (per-line style rows / tags).
3. SRT: unchanged (plain text, no speaker markup) — note this in the README.
4. Overlapping cross-speaker Dialogue rows are legal ASS; libass stacks same-anchor
   collisions automatically — no special handling needed. MP4 burn inherits all of
   this via the .ass.

**VERIFY:** export .ass from a project with 2 styled speakers + 1 line override + 1
default line; open the file: two `Spk_*` styles present with correct colors
(`&HBBGGRR&` order!), Dialogue rows reference them, Name field filled, override line
still gets its own style/tags. Burn a short MP4 and extract a frame inside an overlap:
both speakers' lines visible with distinct styling (LOOK at the frame).

## I3-8 · Bookkeeping

1. `CHANGELOG.md`: new `## v0.2.6 — 2026-07-11 (pending confirmation)` section, house
   style: Bug fixes → I3-1 (**02 Editor**); New features → I3-2 (**02 Editor**),
   speakers as one substantial entry (**02 Editor / 03 Export / Backend**) covering
   I3-3…I3-7.
2. `ROADMAP.md`: check off the three v3.0 items with a trailing note
   "(shipped early in v0.2.6)" — leave the section in place.
3. `subtitler/README.md`: short "Speakers" paragraph in the workflow section +
   the digit-key shortcut; note SRT stays plain.
4. Update the editor shortcut sidebar legend (done in I3-4.3) — double-check it.

## Final verification & server discipline (user is emphatic)

- Check first whether anything already listens on 8765/8766; if yes, REUSE it (never
  start a second server); if no, start exactly ONE. When finished: if YOU started it,
  kill it and prove it's dead (curl connection-refused + no python.exe). If you reused
  a pre-existing one, leave it exactly as found.
- Full regression sweep in the browser before finishing: waveforms render on both tabs
  (v0.2.5 fix), pan/zoom on both tabs, undo/redo, style rail ribbons, new-line chip,
  drag-position routing, export dialog. No console errors anywhere.
- Restore the test project to a sensible state (it may keep the two test speakers —
  they're useful for the user's own testing).
- Do NOT commit. Leave the working tree for user review.

Final message: per-item report (DONE + how verified / issues), deviations, server
cleanup proof.
