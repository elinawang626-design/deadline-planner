"""Timezone helpers. TZ env var wins; fall back to UTC."""
from __future__ import annotations

import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def get_timezone() -> ZoneInfo:
    name = os.environ.get("TZ", "").strip()
    if name:
        try:
            return ZoneInfo(name)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"unknown timezone in TZ env var: {name!r}") from exc
    return ZoneInfo("UTC")
