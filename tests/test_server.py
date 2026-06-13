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


def test_task_without_deadline_is_valid_but_not_scheduled(client):
    body = make_task_body()
    del body["deadline"]
    created = client.post("/api/tasks", json=body).json()
    assert created["deadline"] is None

    summary = client.post("/api/schedule/regenerate").json()
    assert client.get("/api/schedule/blocks").json() == []
    assert any(
        w["type"] == "missing_deadline" and w["taskId"] == created["id"]
        for w in summary["warnings"]
    )

    # setting a deadline later makes it schedulable again
    client.patch(f"/api/tasks/{created['id']}", json={"deadline": iso(future(days=5))})
    client.post("/api/schedule/regenerate")
    assert client.get("/api/schedule/blocks").json() != []


def test_regenerate_creates_blocks_and_respects_lock(client):
    task = client.post("/api/tasks", json=make_task_body()).json()
    summary = client.post("/api/schedule/regenerate").json()
    blocks = client.get("/api/schedule/blocks").json()
    assert summary["createdBlocks"] == len(blocks)
    total_minutes = sum(
        (datetime.fromisoformat(b["endAt"]) - datetime.fromisoformat(b["startAt"]))
        // timedelta(minutes=1)
        for b in blocks
    )
    assert total_minutes == 120
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


def test_regenerate_summary_includes_unscheduled_minutes_and_task_stats(client):
    task = client.post("/api/tasks", json=make_task_body()).json()
    summary = client.post("/api/schedule/regenerate").json()
    assert summary["totalUnscheduledMinutes"] == 0
    stats = {s["taskId"]: s for s in summary["taskStats"]}
    assert stats[task["id"]]["scheduledMinutes"] == 120
    assert stats[task["id"]]["unscheduledMinutes"] == 0


def plan_window(days=1, start_hour=9, hours=1):
    start = future(days=days).replace(hour=start_hour, minute=0, second=0, microsecond=0)
    return iso(start), iso(start + timedelta(hours=hours))


def test_create_plan_with_existing_task(client):
    task = client.post("/api/tasks", json=make_task_body()).json()
    start, end = plan_window()
    res = client.post(
        "/api/plans",
        json={"taskId": task["id"], "startAt": start, "endAt": end, "notes": "先写大纲"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["task"]["id"] == task["id"]
    assert body["block"]["source"] == "manual"
    assert body["block"]["locked"] is True
    assert body["block"]["notes"] == "先写大纲"
    assert "summary" in body and "warnings" in body
    blocks = client.get("/api/schedule/blocks").json()
    assert any(b["id"] == body["block"]["id"] for b in blocks)


def test_create_plan_with_new_task_is_atomic(client):
    start, end = plan_window(hours=2)
    res = client.post(
        "/api/plans",
        json={"newTask": make_task_body(), "startAt": start, "endAt": end},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    task_id = body["task"]["id"]
    assert any(t["id"] == task_id for t in client.get("/api/tasks").json())
    manual = [
        b
        for b in client.get("/api/schedule/blocks").json()
        if b["taskId"] == task_id and b["source"] == "manual"
    ]
    assert len(manual) == 1


def test_create_plan_validation(client):
    start, end = plan_window()
    # neither taskId nor newTask
    assert (
        client.post("/api/plans", json={"startAt": start, "endAt": end}).status_code
        == 422
    )
    # both
    assert (
        client.post(
            "/api/plans",
            json={
                "taskId": "x",
                "newTask": make_task_body(),
                "startAt": start,
                "endAt": end,
            },
        ).status_code
        == 422
    )
    # inverted times
    assert (
        client.post(
            "/api/plans", json={"taskId": "x", "startAt": end, "endAt": start}
        ).status_code
        == 422
    )
    # unknown task creates nothing
    assert (
        client.post(
            "/api/plans", json={"taskId": "missing", "startAt": start, "endAt": end}
        ).status_code
        == 404
    )
    assert client.get("/api/schedule/blocks").json() == []


def test_create_plan_warns_on_overlap_and_overload(client):
    task = client.post("/api/tasks", json=make_task_body()).json()
    start, end = plan_window(hours=2)
    first = client.post(
        "/api/plans", json={"taskId": task["id"], "startAt": start, "endAt": end}
    ).json()
    assert not any(w["type"] == "overlap" for w in first["warnings"])
    # second manual plan overlaps the first -> saved anyway, with a warning
    second = client.post(
        "/api/plans", json={"taskId": task["id"], "startAt": start, "endAt": end}
    )
    assert second.status_code == 200
    assert any(w["type"] == "overlap" for w in second.json()["warnings"])

    # a 7-hour manual plan exceeds the default 6-hour daily cap
    start7, end7 = plan_window(days=2, hours=7)
    res = client.post(
        "/api/plans", json={"taskId": task["id"], "startAt": start7, "endAt": end7}
    )
    assert res.status_code == 200
    assert any(w["type"] == "overloaded_day" for w in res.json()["warnings"])


def test_ai_import_flow(client):
    """End-to-end happy path; detailed AI import rules live in test_ai_plan.py."""
    prompt = client.post(
        "/api/ai-import/generate-prompt",
        json={"mode": "tasks_only", "requirements": "finish thesis by friday"},
    ).json()["prompt"]
    assert "finish thesis by friday" in prompt
    assert "JSON Schema" in prompt

    deadline = future(days=4).replace(hour=18, minute=0, second=0, microsecond=0)
    output = json.dumps(
        {
            "tasks": [
                {
                    "id": "thesis",
                    "title": "Thesis draft",
                    "deadline": iso(deadline),
                    "estimated_minutes": 180,
                    "priority": "high",
                }
            ]
        }
    )
    valid = client.post(
        "/api/ai-import/validate-output", json={"text": output, "mode": "tasks_only"}
    ).json()
    assert valid["ok"] is True
    assert valid["summary"] == {"task_add": 1}

    imported = client.post(
        "/api/ai-import/import",
        json={"text": output, "mode": "tasks_only",
              "previewVersion": valid["previewVersion"]},
    ).json()
    assert imported["applied"] == 1
    tasks = client.get("/api/tasks").json()
    assert tasks[0]["id"] == "thesis"
    assert tasks[0]["estimatedMinutes"] == 180


def test_ai_import_rejects_invalid_output(client):
    no_json = "Here you go: nothing structured"
    res = client.post(
        "/api/ai-import/validate-output", json={"text": no_json, "mode": "tasks_only"}
    )
    assert res.status_code == 422

    bad_priority = json.dumps(
        {
            "tasks": [
                {
                    "id": "x",
                    "title": "X",
                    "deadline": iso(future(days=1)),
                    "estimated_minutes": 60,
                    "priority": "asap",
                }
            ]
        }
    )
    res = client.post(
        "/api/ai-import/validate-output",
        json={"text": bad_priority, "mode": "tasks_only"},
    )
    assert res.status_code == 422
