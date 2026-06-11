import json

import pytest

from planner.importer import ImportRejected, parse_llm_output

VALID = {
    "tasks": [
        {
            "id": "t1",
            "title": "Write report",
            "deadline": "2026-06-15T17:00:00+00:00",
            "estimated_hours": 3,
            "priority": "high",
        }
    ],
    "availability_rules": [
        {
            "id": "r1",
            "weekdays": ["mon", "tue", "wed", "thu", "fri"],
            "start_time": "09:00",
            "end_time": "17:00",
        }
    ],
    "fixed_events": [
        {
            "id": "e1",
            "title": "Standup",
            "start_at": "2026-06-11T10:00:00+00:00",
            "end_at": "2026-06-11T10:30:00+00:00",
        }
    ],
}


def test_plain_json_is_accepted():
    parsed = parse_llm_output(json.dumps(VALID))
    assert parsed.tasks[0].id == "t1"
    assert parsed.availability_rules[0].id == "r1"
    assert parsed.fixed_events[0].id == "e1"


def test_fenced_json_is_accepted():
    text = "```json\n" + json.dumps(VALID, indent=2) + "\n```"
    parsed = parse_llm_output(text)
    assert parsed.tasks[0].title == "Write report"


def test_fenced_block_without_language_tag_is_accepted():
    text = "```\n" + json.dumps(VALID) + "\n```"
    assert parse_llm_output(text).tasks[0].id == "t1"


def test_invalid_priority_is_rejected():
    bad = json.loads(json.dumps(VALID))
    bad["tasks"][0]["priority"] = "urgent"
    with pytest.raises(ImportRejected) as exc:
        parse_llm_output(json.dumps(bad))
    assert any("priority" in e for e in exc.value.errors)


def test_naive_datetime_is_rejected():
    bad = json.loads(json.dumps(VALID))
    bad["tasks"][0]["deadline"] = "2026-06-15T17:00:00"
    with pytest.raises(ImportRejected) as exc:
        parse_llm_output(json.dumps(bad))
    assert any("timezone-aware" in e for e in exc.value.errors)


def test_extra_field_is_rejected():
    bad = json.loads(json.dumps(VALID))
    bad["tasks"][0]["notes"] = "surprise"
    with pytest.raises(ImportRejected):
        parse_llm_output(json.dumps(bad))


def test_non_positive_hours_is_rejected():
    bad = json.loads(json.dumps(VALID))
    bad["tasks"][0]["estimated_hours"] = 0
    with pytest.raises(ImportRejected):
        parse_llm_output(json.dumps(bad))


def test_surrounding_prose_is_rejected():
    with pytest.raises(ImportRejected):
        parse_llm_output("Here is your JSON:\n" + json.dumps(VALID))
    with pytest.raises(ImportRejected):
        parse_llm_output(json.dumps(VALID) + "\nHope this helps!")


def test_prose_around_fenced_block_is_rejected():
    text = "Sure!\n```json\n" + json.dumps(VALID) + "\n```\nDone."
    with pytest.raises(ImportRejected):
        parse_llm_output(text)


def test_multiple_json_objects_are_rejected():
    with pytest.raises(ImportRejected):
        parse_llm_output(json.dumps(VALID) + "\n" + json.dumps(VALID))


def test_empty_input_is_rejected():
    with pytest.raises(ImportRejected):
        parse_llm_output("   \n  ")
