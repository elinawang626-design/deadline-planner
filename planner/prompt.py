"""Build the copy-paste prompt for a human-driven LLM round trip."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Sequence

from planner.models import AvailabilityRule, FixedEvent, ParsedInput, ParsedTask


def build_prompt(
    raw_input: str,
    tasks: Sequence[ParsedTask],
    rules: Sequence[AvailabilityRule],
    fixed_events: Sequence[FixedEvent],
    now: datetime,
    tz_name: str,
) -> str:
    schema = json.dumps(ParsedInput.model_json_schema(), indent=2, ensure_ascii=False)
    existing = ParsedInput(
        tasks=list(tasks), availability_rules=list(rules), fixed_events=list(fixed_events)
    )
    existing_json = json.dumps(
        existing.model_dump(mode="json"), indent=2, ensure_ascii=False
    )

    return f"""You are a task-parsing assistant for a local scheduling tool.

Current time: {now.isoformat()}
Timezone: {tz_name}

## Existing data (already stored locally)
Reuse the same `id` to update an existing record; new records need new ids.
{existing_json}

## User's raw input
{raw_input}

## Your job
Convert the user's raw input into JSON matching the schema below.

Rules:
- Return ONLY a single JSON object. No prose, no explanations, no multiple objects.
- Do NOT produce any calendar blocks or schedule; the local tool computes the
  schedule deterministically. Only tasks, availability_rules and fixed_events.
- Every datetime must be a timezone-aware ISO 8601 value (with UTC offset),
  interpreted in the timezone above unless the user says otherwise.
- estimated_hours must be a positive integer number of whole hours.
- priority must be one of: high, medium, low.
- Do not invent fields; unknown fields are rejected by the importer.

## JSON Schema (ParsedInput)
{schema}
"""
