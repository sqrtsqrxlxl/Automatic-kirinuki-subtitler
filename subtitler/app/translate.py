from __future__ import annotations

import json
import re
import uuid
from typing import Callable

from . import logger
from .models import Line, Word

CHUNK_SIZE = 300
UPCOMING_CTX_WORDS = 30
PREV_CTX_LINES = 2

Report = Callable[[float, str], None]

SYSTEM_PROMPT = """You are a professional subtitler translating {src_lang_name} dialogue into {tgt_lang_name}.
You receive a numbered list of transcribed words. Your tasks:
1. Group consecutive words into subtitle lines. Each line must be a natural
   phrase or sentence fragment. HARD LIMITS: a line covers at most 20 words
   of source text AND its {tgt_lang_name} translation must be at most 30 characters.
   Prefer breaking at sentence ends, clause boundaries, and pauses.
   Prefer COMPLETE sentences. Never split a sentence across lines unless its
   translation would exceed the character limit.
   Prefer fewer, longer lines over many short fragments. Merge short
   interjections into the neighbouring line when natural.
2. Translate each line into natural, colloquial {tgt_lang_name}, using the
   surrounding lines as context. Do not add words that were not spoken.
   The translation may be loose: prioritise natural {tgt_lang_name} phrasing
   over word-for-word correspondence with the source.
Return ONLY a JSON object of this exact shape, no markdown fences, no commentary:
{{"lines": [{{"first_word": <int>, "last_word": <int>, "translation": "<translated text>"}}]}}
Rules for indices: use the word numbers given in the input; lines must be
contiguous, non-overlapping, in order, and together cover EVERY in-scope word
exactly once (first line starts at the first in-scope word, each next line
starts at previous last_word + 1, final line ends at the last in-scope word)."""

LANG_NAMES = {"ja": "Japanese", "zh": "Simplified Chinese", "en": "English", "ko": "Korean"}


def _lang_name(code: str) -> str:
    return LANG_NAMES.get(code, code)


def test_llm_connection(settings) -> tuple[bool, str]:
    """1-token chat completion used by both /api/settings/test and the
    pipeline's fail-fast check (I2-5)."""
    if not settings.llm_api_key:
        return False, "No API key set."
    try:
        from openai import OpenAI

        client = OpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key)
        client.chat.completions.create(
            model=settings.llm_model,
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=1,
        )
        return True, "Connection OK."
    except Exception as e:  # noqa: BLE001
        return False, f"LLM request failed: {e}"


def _strip_fences(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    return text.strip()


def _validate_chunk_response(data: dict, first_idx: int, last_idx: int) -> list[dict]:
    if not isinstance(data, dict) or "lines" not in data or not isinstance(data["lines"], list):
        raise ValueError("response missing 'lines' array")
    lines = data["lines"]
    if not lines:
        raise ValueError("empty lines array")
    expected_start = first_idx
    for i, ln in enumerate(lines):
        if not all(k in ln for k in ("first_word", "last_word", "translation")):
            raise ValueError(f"line {i} missing required fields")
        fw, lw = ln["first_word"], ln["last_word"]
        if not isinstance(fw, int) or not isinstance(lw, int):
            raise ValueError(f"line {i} indices must be ints")
        if fw != expected_start:
            raise ValueError(f"line {i} first_word={fw} but expected {expected_start} (contiguity)")
        if lw < fw:
            raise ValueError(f"line {i} last_word < first_word")
        if not isinstance(ln["translation"], str) or not ln["translation"].strip():
            raise ValueError(f"line {i} translation empty")
        expected_start = lw + 1
    if lines[-1]["last_word"] != last_idx:
        raise ValueError(f"last line ends at {lines[-1]['last_word']} but chunk ends at {last_idx}")
    return lines


def _rule_based_fallback(words: list[Word], first_idx: int, last_idx: int) -> list[dict]:
    lines = []
    start = first_idx
    i = first_idx
    while i <= last_idx:
        count = 0
        while i <= last_idx and count < 10:
            w = words[i]
            count += 1
            ends_sentence = bool(re.search(r"[。｡．！？!?]$", w.text.strip()))
            gap = (words[i + 1].start - w.end) if i + 1 <= last_idx else 999
            if ends_sentence or gap > 0.6 or count >= 10:
                lines.append({"first_word": start, "last_word": i, "translation": ""})
                start = i + 1
                i += 1
                break
            i += 1
        else:
            continue
    if start <= last_idx:
        lines.append({"first_word": start, "last_word": last_idx, "translation": ""})
    return lines


def _call_llm(client, model: str, system: str, user: str) -> str:
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.3,
            response_format={"type": "json_object"},
        )
    except Exception:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.3,
        )
    return resp.choices[0].message.content or ""


def segment_and_translate(project_id: str, words: list[Word], project, settings, report: Report) -> tuple[list[Line], str, str]:
    """Returns (lines, translation_status, translation_error) — I2-5."""
    from openai import OpenAI

    if not words:
        return [], "ok", ""

    client = OpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key)
    src_name = _lang_name(project.source_lang)
    tgt_name = _lang_name(project.target_lang)
    system = SYSTEM_PROMPT.format(src_lang_name=src_name, tgt_lang_name=tgt_name)

    n = len(words)
    n_chunks = (n + CHUNK_SIZE - 1) // CHUNK_SIZE
    result_lines: list[Line] = []
    prev_source_lines: list[str] = []
    fallback_chunks = 0
    last_llm_error = ""

    for c in range(n_chunks):
        first_idx = c * CHUNK_SIZE
        last_idx = min(n - 1, first_idx + CHUNK_SIZE - 1)
        report(c / n_chunks, f"Translating chunk {c + 1}/{n_chunks}")
        logger.log(project_id, "info", f"llm: chunk {c + 1}/{n_chunks} -> words {first_idx}-{last_idx}")

        in_scope = "\n".join(f"{i}: {words[i].text.strip()}" for i in range(first_idx, last_idx + 1))
        upcoming_end = min(n - 1, last_idx + UPCOMING_CTX_WORDS)
        upcoming_text = " ".join(w.text.strip() for w in words[last_idx + 1 : upcoming_end + 1]) or "(none)"
        prev_text = "\n".join(prev_source_lines[-PREV_CTX_LINES:]) or "(none)"

        user = (
            f"PREVIOUS CONTEXT (already subtitled, do not re-segment):\n{prev_text}\n\n"
            f"IN-SCOPE WORDS (segment and translate exactly these):\n{in_scope}\n\n"
            f"UPCOMING CONTEXT (do not segment, for reference only):\n{upcoming_text}"
        )

        parsed_lines = None
        last_error = None
        for attempt in range(2):
            try:
                raw = _call_llm(client, settings.llm_model, system, user)
                data = json.loads(_strip_fences(raw))
                parsed_lines = _validate_chunk_response(data, first_idx, last_idx)
                break
            except Exception as e:  # noqa: BLE001
                last_error = e
                logger.log(project_id, "warn", f"llm: chunk {c + 1} invalid on attempt {attempt + 1}: {e}")
                if attempt == 0:
                    user = user + f"\n\nYour previous answer was invalid because: {e}. Return corrected JSON only."

        if parsed_lines is None:
            logger.log(project_id, "error", f"llm: chunk {c + 1} failed twice ({last_error}); using rule-based fallback")
            fallback_chunks += 1
            last_llm_error = str(last_error)
            parsed_lines = _rule_based_fallback(words, first_idx, last_idx)
        else:
            logger.log(project_id, "info", f"llm: chunk {c + 1} ok -> {len(parsed_lines)} lines")

        for pl in parsed_lines:
            fw, lw = pl["first_word"], pl["last_word"]
            text_src = "".join(words[i].text for i in range(fw, lw + 1)).strip()
            line = Line(
                id=uuid.uuid4().hex[:8],
                start=words[fw].start,
                end=words[lw].end,
                text_src=text_src,
                text_tgt=pl.get("translation", ""),
            )
            result_lines.append(line)
            prev_source_lines.append(text_src)

    _postprocess(result_lines)
    merges = _merge_fragments(result_lines)
    logger.log(project_id, "info", f"translate: merge pass -> {merges} merge(s)")
    report(1.0, "Translation complete")

    if fallback_chunks == 0:
        translation_status, translation_error = "ok", ""
    elif fallback_chunks == n_chunks:
        translation_status, translation_error = "failed", last_llm_error
    else:
        translation_status, translation_error = "partial", last_llm_error

    return result_lines, translation_status, translation_error


def _postprocess(lines: list[Line]) -> None:
    for i, line in enumerate(lines):
        next_start = lines[i + 1].start if i + 1 < len(lines) else None
        if line.end - line.start < 1.0:
            new_end = line.start + 1.0
            if next_start is not None:
                new_end = min(new_end, next_start)
            line.end = new_end
        if next_start is not None:
            if next_start - line.end < 0.2:
                line.end = next_start
            if line.end > next_start:
                line.end = next_start


def _merge_fragments(lines: list[Line]) -> int:
    """I2-6: merge short fragments into the following line so segmentation
    isn't overly fine. Mutates `lines` in place. Returns the merge count."""
    merges = 0
    changed = True
    while changed:
        changed = False
        i = 0
        while i < len(lines) - 1:
            line = lines[i]
            nxt = lines[i + 1]
            dur = line.end - line.start
            gap = nxt.start - line.end
            if dur < 1.2 and gap < 0.2 and len(line.text_tgt + nxt.text_tgt) <= 30:
                nxt.text_src = (line.text_src + " " + nxt.text_src).strip()
                nxt.text_tgt = (line.text_tgt + nxt.text_tgt).strip()
                nxt.start = line.start
                del lines[i]
                merges += 1
                changed = True
            else:
                i += 1
    return merges
