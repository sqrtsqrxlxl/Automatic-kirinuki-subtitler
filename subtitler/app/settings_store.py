from __future__ import annotations

import json
import threading

from .models import Settings
from .paths import SETTINGS_PATH

_lock = threading.Lock()


def load_settings() -> Settings:
    with _lock:
        if not SETTINGS_PATH.exists():
            s = Settings()
            SETTINGS_PATH.write_text(s.model_dump_json(indent=2), encoding="utf-8")
            return s
        return Settings.model_validate_json(SETTINGS_PATH.read_text(encoding="utf-8"))


def save_settings(s: Settings) -> None:
    with _lock:
        SETTINGS_PATH.write_text(s.model_dump_json(indent=2), encoding="utf-8")


def masked_api_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 4:
        return "*" * len(key)
    return "*" * (len(key) - 4) + key[-4:]
