"""API key storage, kept out of SQLite on purpose.

Keys live in a single JSON file next to the database (``.planner/api_keys.json``)
with ``0600`` permissions (current user read/write only). The HTTP layer only
ever exposes whether a provider is ``configured`` — it never returns, logs, or
writes the plaintext key anywhere else.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from planner.webdb import db_path

PROVIDERS = ("openai", "deepseek", "claude")


def keys_path() -> Path:
    return db_path().parent / "api_keys.json"


def _load() -> dict[str, str]:
    path = keys_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, str) and v}


def _save(keys: dict[str, str]) -> None:
    path = keys_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Create with 0600 from the start, then chmod in case the file pre-existed
    # with looser permissions (umask can also relax the create mode).
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(keys, handle, ensure_ascii=False, indent=2)
    os.chmod(path, 0o600)


def get_key(provider: str) -> str | None:
    return _load().get(provider)


def set_key(provider: str, key: str) -> None:
    keys = _load()
    keys[provider] = key
    _save(keys)


def delete_key(provider: str) -> None:
    keys = _load()
    if keys.pop(provider, None) is not None:
        _save(keys)


def configured() -> dict[str, bool]:
    keys = _load()
    return {provider: bool(keys.get(provider)) for provider in PROVIDERS}
