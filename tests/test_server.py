import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from planner.server import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PLANNER_DB", str(tmp_path / "web.db"))
    return TestClient(app)


def iso(dt):
    return dt.isoformat()


def future(days=0):
    return datetime.now(timezone.utc) + timedelta(days=days)


def make_task_body():
    return {
        "title": "Write report",
        "type": "assignment",
        "deadline": iso(future(days=5)),
        "estimatedMinutes": 120,
        "priority": "high",
        "splittable": True,
    }


def test_task_crud(client):
    created = client.post("/api/tasks", json=make_task_body()).json()
    assert created["title"] == "Write report"
    assert client.get("/api/tasks").json()[0]["id"] == created["id"]

    patched = client.patch(f"/api/tasks/{created['id']}", json={"status": "completed"})
    assert patched.json()["status"] == "completed"

    assert client.delete(f"/api/tasks/{created['id']}").status_code == 204
    assert client.get("/api/tasks").json() == []


def test_task_rejects_extra_fields(client):
    bad = dict(make_task_body(), surprise="x")
    assert client.post("/api/tasks", json=bad).status_code == 422


def test_regenerate_creates_blocks_and_respects_lock(client):
    task = client.post("/api/tasks", json=make_task_body()).json()
    summary = client.post("/api/schedule/regenerate").json()
    assert summary["createdBlocks"] == 2
    blocks = client.get("/api/schedule/blocks").json()
    assert len(blocks) == 2
    assert all(b["taskId"] == task["id"] for b in blocks)

    locked = client.patch(
        f"/api/schedule/blocks/{blocks[0]['id']}", json={"locked": True}
    ).json()
    assert locked["locked"] is True
    client.post("/api/schedule/regenerate")
    ids = {b["id"] for b in client.get("/api/schedule/blocks").json()}
    assert locked["id"] in ids


def test_block_remove(client):
    client.post("/api/tasks", json=make_task_body())
    client.post("/api/schedule/regenerate")
    block = client.get("/api/schedule/blocks").json()[0]
    assert client.delete(f"/api/schedule/blocks/{block['id']}").status_code == 204


def test_availability_crud_and_settings(client):
    window = client.post(
        "/api/availability", json={"weekday": 1, "startTime": "13:00", "endTime": "18:00"}
    ).json()
    assert client.get("/api/availability").json()[0]["id"] == window["id"]
    patched = client.patch(
        f"/api/availability/{window['id']}", json={"endTime": "19:00"}
    ).json()
    assert patched["endTime"] == "19:00"
    assert client.delete(f"/api/availability/{window['id']}").status_code == 204

    assert client.get("/api/settings").json()["dailyMaxPlannedHours"] == 6
    put = client.put("/api/settings", json={"dailyMaxPlannedHours": 8}).json()
    assert put["dailyMaxPlannedHours"] == 8
    assert client.get("/api/settings").json()["dailyMaxPlannedHours"] == 8


def test_availability_rejects_inverted_window(client):
    res = client.post(
        "/api/availability", json={"weekday": 1, "startTime": "18:00", "endTime": "13:00"}
    )
    assert res.status_code == 422


def test_ai_import_flow(client):
    prompt = client.post(
        "/api/ai-import/generate-prompt", json={"rawInput": "finish thesis by friday"}
    ).json()["prompt"]
    assert "finish thesis by friday" in prompt
    assert "JSON Schema" in prompt

    output = json.dumps(
        {
            "tasks": [
                {
                    "id": "thesis",
                    "title": "Thesis draft",
                    "deadline": iso(future(days=4)),
                    "estimated_hours": 3,
                    "priority": "high",
                }
            ]
        }
    )
    valid = client.post("/api/ai-import/validate-output", json={"text": output}).json()
    assert valid == {"ok": True, "errors": [], "count": 1}

    imported = client.post("/api/ai-import/import", json={"text": output}).json()
    assert imported == {"imported": 1}
    tasks = client.get("/api/tasks").json()
    assert tasks[0]["id"] == "thesis"
    assert tasks[0]["estimatedMinutes"] == 180


def test_ai_import_rejects_prose_and_bad_priority(client):
    bad_wrap = 'Here you go: {"tasks": []}'
    res = client.post("/api/ai-import/validate-output", json={"text": bad_wrap})
    assert res.status_code == 422

    bad_priority = json.dumps(
        {
            "tasks": [
                {
                    "title": "X",
                    "deadline": iso(future(days=1)),
                    "estimated_hours": 1,
                    "priority": "urgent",
                }
            ]
        }
    )
    res = client.post("/api/ai-import/validate-output", json={"text": bad_priority})
    assert res.status_code == 422
