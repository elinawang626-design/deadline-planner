import json
from datetime import datetime, timezone

import pytest
from typer.testing import CliRunner

from planner import db
from planner.cli import app

runner = CliRunner()

# Scheduling starts from "now", so block packing depends on the wall clock.
# Freeze it near the fixture deadlines to keep these smoke tests deterministic.
FROZEN_NOW = datetime(2098, 12, 28, 8, 0, tzinfo=timezone.utc)

LLM_OUTPUT = {
    "tasks": [
        {
            "id": "t1",
            "title": "Write report",
            "deadline": "2099-01-10T17:00:00+00:00",
            "estimated_hours": 2,
            "priority": "high",
        }
    ],
    "availability_rules": [],
    "fixed_events": [
        {
            "id": "e1",
            "title": "Standup",
            "start_at": "2099-01-05T10:00:00+00:00",
            "end_at": "2099-01-05T10:30:00+00:00",
        }
    ],
}


@pytest.fixture(autouse=True)
def utc_tz(monkeypatch):
    monkeypatch.setenv("TZ", "UTC")


@pytest.fixture(autouse=True)
def frozen_now(monkeypatch):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return FROZEN_NOW.astimezone(tz) if tz else FROZEN_NOW.replace(tzinfo=None)

    monkeypatch.setattr("planner.cli.datetime", FrozenDatetime)


@pytest.fixture()
def db_path(tmp_path):
    return tmp_path / "planner.db"


def invoke(db_path, *args):
    return runner.invoke(app, ["--db", str(db_path), *args])


def test_generate_prompt_smoke(db_path, tmp_path):
    input_file = tmp_path / "input.txt"
    input_file.write_text("finish report by friday", encoding="utf-8")
    result = invoke(db_path, "generate-prompt", "--input", str(input_file))
    assert result.exit_code == 0, result.output
    assert "finish report by friday" in result.output
    assert "Timezone: UTC" in result.output
    assert "estimated_hours" in result.output  # schema included


def test_import_output_and_schedule_smoke(db_path, tmp_path):
    out_file = tmp_path / "llm_output.txt"
    out_file.write_text(json.dumps(LLM_OUTPUT), encoding="utf-8")

    result = invoke(db_path, "import-output", "--file", str(out_file))
    assert result.exit_code == 0, result.output
    assert "1 task(s)" in result.output

    result = invoke(db_path, "schedule")
    assert result.exit_code == 0, result.output
    assert "scheduled 2 block(s)" in result.output

    conn = db.connect(db_path)
    try:
        blocks = db.load_scheduled_blocks(conn)
    finally:
        conn.close()
    assert len(blocks) == 2
    assert all(b.task_id == "t1" for b in blocks)


def test_import_invalid_output_writes_nothing(db_path, tmp_path):
    out_file = tmp_path / "bad.txt"
    out_file.write_text("Here you go: " + json.dumps(LLM_OUTPUT), encoding="utf-8")

    result = invoke(db_path, "import-output", "--file", str(out_file))
    assert result.exit_code == 1

    conn = db.connect(db_path)
    try:
        assert db.load_tasks(conn) == []
        assert db.load_fixed_events(conn) == []
    finally:
        conn.close()


def test_show_day_and_show_week_smoke(db_path, tmp_path):
    out_file = tmp_path / "llm_output.txt"
    out_file.write_text(json.dumps(LLM_OUTPUT), encoding="utf-8")
    assert invoke(db_path, "import-output", "--file", str(out_file)).exit_code == 0
    assert invoke(db_path, "schedule").exit_code == 0

    conn = db.connect(db_path)
    try:
        blocks = db.load_scheduled_blocks(conn)
    finally:
        conn.close()
    day = blocks[0].start_at.date().isoformat()

    result = invoke(db_path, "show-day", day)
    assert result.exit_code == 0, result.output
    assert "Write report" in result.output

    result = invoke(db_path, "show-week", day)
    assert result.exit_code == 0, result.output
    assert "Write report" in result.output

    # the fixed event's day shows the event
    result = invoke(db_path, "show-day", "2099-01-05")
    assert result.exit_code == 0
    assert "Standup" in result.output


def test_show_day_rejects_bad_date(db_path):
    result = invoke(db_path, "show-day", "not-a-date")
    assert result.exit_code == 1
