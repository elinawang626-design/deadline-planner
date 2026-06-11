"""Strict import of human-pasted LLM output.

Accepted forms:
  1. The whole text (after stripping whitespace) is a single JSON object.
  2. The whole text is exactly one fenced code block (``` or ```json)
     whose content is a single JSON object.

Anything else — leading/trailing prose, multiple JSON objects, multiple
fenced blocks — is rejected.
"""
from __future__ import annotations

import json
import re

from pydantic import ValidationError

from planner.models import ParsedInput

_FENCED_ONLY = re.compile(
    r"\A```(?:json)?[ \t]*\r?\n(?P<body>.*?)\r?\n?```\s*\Z", re.DOTALL
)


class ImportRejected(ValueError):
    """Raised when pasted output cannot be safely imported."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


def _extract_json_text(raw: str) -> str:
    text = raw.strip()
    if not text:
        raise ImportRejected(["input is empty"])

    fenced = _FENCED_ONLY.match(text)
    if fenced:
        return fenced.group("body").strip()

    if "```" in text:
        raise ImportRejected(
            ["output must be a single JSON object or exactly one fenced JSON "
             "block with no surrounding text"]
        )
    return text


def parse_llm_output(raw: str) -> ParsedInput:
    """Parse pasted LLM output into a validated ParsedInput.

    Raises ImportRejected with structured error messages on any problem.
    """
    text = _extract_json_text(raw)

    try:
        data, end = json.JSONDecoder().raw_decode(text)
    except json.JSONDecodeError as exc:
        raise ImportRejected([f"invalid JSON: {exc}"]) from exc

    if text[end:].strip():
        raise ImportRejected(
            ["extra content after the JSON object (exactly one JSON object is allowed)"]
        )
    if not isinstance(data, dict):
        raise ImportRejected(["top-level JSON value must be an object"])

    try:
        return ParsedInput.model_validate(data)
    except ValidationError as exc:
        errors = [
            f"{'.'.join(str(loc) for loc in err['loc']) or '<root>'}: {err['msg']}"
            for err in exc.errors()
        ]
        raise ImportRejected(errors) from exc
