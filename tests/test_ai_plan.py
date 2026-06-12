"""Tests for the AI-led plan import (planner.ai_plan + /api/ai-import/*)."""
import json
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from planner import ai_plan
from planner.ai_plan import PlanRejected, WebState, build_scenario, extract_plan
from planner.server import app
from planner.webmodels import (
    AvailabilityWindow,
    FixedEvent,
    ScheduledBlock,
    Settings,
    Task,
)

NOW = datetime.now().astimezone()


def at(days: int, hour: int, minute: int = 0) -> datetime:
    return (NOW + timedelta(days=days)).replace(
        hour=hour, minute=minute, second=0, microsecond=0
    )


def make_task(task_id: str, *, deadline=None, est=120, **kwargs) -> Task:
    return Task(
        id=task_id,
        title=kwargs.pop("title", f"任务 {task_id}"),
        deadline=deadline or at(5, 18),
        estimatedMinutes=est,
        createdAt=NOW,
        **kwargs,
    )


def make_block(
    block_id: str, task_id: str, start: datetime, end: datetime, *,
    source="local_auto", locked=False, done=False,
) -> ScheduledBlock:
    return ScheduledBlock(
        id=block_id, taskId=task_id, startAt=start, endAt=end,
        source=source, locked=locked, done=done,
    )


def make_state(tasks=(), blocks=(), availability=(), events=(), cap=6) -> WebState:
    return WebState(
        tasks=list(tasks),
        blocks=list(blocks),
        availability=list(availability),
        events=list(events),
        settings=Settings(dailyMaxPlannedHours=cap),
    )


def plan_of(**kwargs) -> ai_plan.AiPlan:
    return ai_plan.AiPlan.model_validate(kwargs)


# ---- extraction ----


def test_extract_accepts_pure_json_fenced_and_prose():
    payload = {"tasks": [], "deleted_ids": []}
    pure = json.dumps(payload)
    fenced = f"```json\n{pure}\n```"
    prose = f"好的，这是我的计划：\n{fenced}\n按需调整即可。"
    for text in (pure, fenced, prose):
        assert extract_plan(text) == ai_plan.AiPlan.model_validate(payload)


def test_extract_rejects_no_json_and_multiple_candidates():
    with pytest.raises(PlanRejected):
        extract_plan("这里没有任何 JSON")
    two = json.dumps({"tasks": []}) + "\n或者\n" + json.dumps({"deleted_ids": []})
    with pytest.raises(PlanRejected, match="多个"):
        extract_plan(two)


def test_extract_rejects_unknown_fields_and_naive_datetime():
    with pytest.raises(PlanRejected):
        extract_plan(json.dumps({"tasks": [], "surprise": 1}))
    naive = {
        "tasks": [
            {"id": "t1", "title": "X", "deadline": "2026-07-01T10:00:00",
             "estimated_minutes": 60}
        ]
    }
    with pytest.raises(PlanRejected):
        extract_plan(json.dumps(naive))


def test_extract_ignores_braces_inside_strings():
    payload = {"tasks": [{"id": "t1", "title": "含 { 花括号 } 的标题",
                          "deadline": at(3, 18).isoformat(), "estimated_minutes": 60}]}
    text = "说明 {不是 json}\n" + json.dumps(payload, ensure_ascii=False)
    assert extract_plan(text).tasks[0].title == "含 { 花括号 } 的标题"


# ---- task / event / deletion changes ----


def test_task_add_update_delete_and_omission():
    state = make_state(tasks=[make_task("keep"), make_task("upd"), make_task("gone")])
    plan = plan_of(
        tasks=[
            {"id": "new1", "title": "新任务", "deadline": at(4, 18).isoformat(),
             "estimated_minutes": 90},
            {"id": "upd", "priority": "urgent"},
        ],
        deleted_ids=["gone"],
    )
    scenario = build_scenario(state, plan, "tasks_only", NOW)
    assert not scenario.errors
    kinds = {c.changeId: c.kind for c in scenario.changes}
    assert kinds == {
        "task:new1": "task_add",
        "task:upd": "task_update",
        "delete-task:gone": "task_delete",
    }
    update = next(c for c in scenario.changes if c.changeId == "task:upd")
    assert [(f.field, f.old, f.new) for f in update.fields] == [
        ("priority", "medium", "urgent")
    ]
    assert set(scenario.final_tasks) == {"keep", "upd", "new1"}
    assert scenario.final_tasks["upd"].priority == "urgent"


def test_unchanged_update_produces_no_change():
    state = make_state(tasks=[make_task("t1", title="同名")])
    plan = plan_of(tasks=[{"id": "t1", "title": "同名"}])
    scenario = build_scenario(state, plan, "tasks_only", NOW)
    assert scenario.changes == []


def test_new_task_missing_fields_and_unknown_deleted_id_block_import():
    state = make_state()
    plan = plan_of(tasks=[{"id": "new1", "title": "缺字段"}], deleted_ids=["ghost"])
    scenario = build_scenario(state, plan, "tasks_only", NOW)
    assert any("缺少必填字段" in e for e in scenario.errors)
    assert any("ghost" in e for e in scenario.errors)


# ---- blocks: creation, references, protection ----


def ai_block_payload(task_id: str, start: datetime, hours: int = 1, block_id=None) -> dict:
    payload = {
        "task_id": task_id,
        "start_at": start.isoformat(),
        "end_at": (start + timedelta(hours=hours)).isoformat(),
    }
    if block_id:
        payload["id"] = block_id
    return payload


def test_new_task_with_block_in_same_reply():
    state = make_state()
    plan = plan_of(
        tasks=[{"id": "essay", "title": "论文", "deadline": at(5, 18).isoformat(),
                "estimated_minutes": 60}],
        scheduled_blocks=[ai_block_payload("essay", at(2, 10))],
    )
    scenario = build_scenario(state, plan, "ai_plan", NOW)
    assert not scenario.errors
    block_change = next(c for c in scenario.changes if c.kind == "block_add")
    assert block_change.dependsOn == ["task:essay"]
    # rejecting the task drops the dependent block automatically
    rejected = build_scenario(state, plan, "ai_plan", NOW, accepted=set())
    assert rejected.effective_ids == set()


def test_block_with_unknown_task_blocks_import():
    scenario = build_scenario(
        make_state(),
        plan_of(scheduled_blocks=[ai_block_payload("nobody", at(1, 10))]),
        "ai_plan",
        NOW,
    )
    assert any("未知任务" in e for e in scenario.errors)


def test_ai_optimize_replaces_only_future_unlocked_ai_blocks():
    task = make_task("t1")
    blocks = [
        make_block("b-ai", "t1", at(1, 9), at(1, 10), source="ai"),
        make_block("b-auto", "t1", at(1, 10), at(1, 11), source="local_auto"),
        make_block("b-manual", "t1", at(1, 11), at(1, 12), source="manual"),
        make_block("b-locked", "t1", at(1, 13), at(1, 14), source="ai", locked=True),
        make_block("b-done", "t1", at(1, 14), at(1, 15), source="ai", done=True),
        make_block("b-past", "t1", at(-1, 9), at(-1, 10), source="ai"),
    ]
    plan = plan_of(scheduled_blocks=[ai_block_payload("t1", at(2, 9))])
    scenario = build_scenario(
        make_state(tasks=[task], blocks=blocks), plan, "ai_optimize", NOW
    )
    assert not scenario.errors
    removed = {c.targetId for c in scenario.changes if c.kind == "block_remove"}
    assert removed == {"b-ai"}
    kept = {k.id: k.reason for k in scenario.kept_blocks}
    assert kept["b-auto"] == "not_replaced"
    assert kept["b-manual"] == "manual"
    assert kept["b-locked"] == "locked"
    assert kept["b-done"] == "done"


def test_ai_plan_mode_also_replaces_local_auto_blocks():
    task = make_task("t1")
    blocks = [
        make_block("b-ai", "t1", at(1, 9), at(1, 10), source="ai"),
        make_block("b-auto", "t1", at(1, 10), at(1, 11), source="local_auto"),
        make_block("b-manual", "t1", at(1, 11), at(1, 12), source="manual"),
    ]
    plan = plan_of(scheduled_blocks=[ai_block_payload("t1", at(2, 9))])
    scenario = build_scenario(make_state(tasks=[task], blocks=blocks), plan, "ai_plan", NOW)
    removed = {c.targetId for c in scenario.changes if c.kind == "block_remove"}
    assert removed == {"b-ai", "b-auto"}


def test_moving_existing_ai_block_and_protected_move_rejected():
    task = make_task("t1")
    blocks = [
        make_block("b-ai", "t1", at(1, 9), at(1, 10), source="ai"),
        make_block("b-manual", "t1", at(1, 11), at(1, 12), source="manual"),
    ]
    state = make_state(tasks=[task], blocks=blocks)
    moved = build_scenario(
        state,
        plan_of(scheduled_blocks=[ai_block_payload("t1", at(2, 9), block_id="b-ai")]),
        "ai_optimize",
        NOW,
    )
    assert not moved.errors
    assert {c.kind for c in moved.changes} == {"block_move"}
    assert moved.final_blocks["b-ai"].startAt == at(2, 9)
    assert moved.final_blocks["b-ai"].source == "ai"

    protected = build_scenario(
        state,
        plan_of(scheduled_blocks=[ai_block_payload("t1", at(2, 9), block_id="b-manual")]),
        "ai_optimize",
        NOW,
    )
    assert any("受保护" in e for e in protected.errors)


def test_deleting_protected_block_via_deleted_ids_blocks_import():
    task = make_task("t1")
    block = make_block("b-locked", "t1", at(1, 9), at(1, 10), source="ai", locked=True)
    scenario = build_scenario(
        make_state(tasks=[task], blocks=[block]),
        plan_of(deleted_ids=["b-locked"]),
        "ai_optimize",
        NOW,
    )
    assert any("受保护" in e for e in scenario.errors)


# ---- placement rules ----


def test_block_conflicts_block_import():
    task = make_task("t1", deadline=at(3, 18))
    event = FixedEvent(id="ev1", title="牙医", startAt=at(1, 10), endAt=at(1, 11))
    manual = make_block("b-man", "t1", at(1, 13), at(1, 14), source="manual")
    state = make_state(tasks=[task], blocks=[manual], events=[event])

    cases = {
        "与固定事件": ai_block_payload("t1", at(1, 10)),
        "与已保留的时间块": ai_block_payload("t1", at(1, 13)),
        "晚于任务": ai_block_payload("t1", at(4, 10)),  # past deadline
        "超出可用时间窗口": ai_block_payload("t1", at(1, 20)),  # outside default 9-17
    }
    for expected, payload in cases.items():
        scenario = build_scenario(
            state, plan_of(scheduled_blocks=[payload]), "ai_optimize", NOW
        )
        assert any(expected in e for e in scenario.errors), expected

    overlap = plan_of(
        scheduled_blocks=[
            ai_block_payload("t1", at(1, 9)),
            ai_block_payload("t1", at(1, 9, 30)),
        ]
    )
    scenario = build_scenario(state, overlap, "ai_optimize", NOW)
    assert any("同批次" in e for e in scenario.errors)


def test_block_before_earliest_start_blocks_import():
    task = make_task("t1", earliestStartAt=at(2, 9))
    scenario = build_scenario(
        make_state(tasks=[task]),
        plan_of(scheduled_blocks=[ai_block_payload("t1", at(1, 10))]),
        "ai_plan",
        NOW,
    )
    assert any("允许开始时间" in e for e in scenario.errors)


def test_block_respects_custom_availability():
    task = make_task("t1")
    start = at(1, 19)
    weekday_js = (start.weekday() + 1) % 7
    evening = AvailabilityWindow(
        id="w1", weekday=weekday_js, startTime="18:00", endTime="22:00"
    )
    plan = plan_of(scheduled_blocks=[ai_block_payload("t1", start)])
    ok = build_scenario(
        make_state(tasks=[task], availability=[evening]), plan, "ai_plan", NOW
    )
    assert not ok.errors
    bad = build_scenario(make_state(tasks=[task]), plan, "ai_plan", NOW)
    assert any("可用时间窗口" in e for e in bad.errors)


def test_rejecting_removal_makes_colliding_add_an_error():
    task = make_task("t1")
    old = make_block("b-old", "t1", at(1, 10), at(1, 11), source="ai")
    state = make_state(tasks=[task], blocks=[old])
    plan = plan_of(scheduled_blocks=[ai_block_payload("t1", at(1, 10, 30))])
    all_accepted = build_scenario(state, plan, "ai_optimize", NOW)
    assert not all_accepted.errors
    add_id = next(c.changeId for c in all_accepted.changes if c.kind == "block_add")
    partial = build_scenario(state, plan, "ai_optimize", NOW, accepted={add_id})
    assert any("重叠" in e for e in partial.errors)


def test_tasks_only_mode_rejects_scheduled_blocks():
    task = make_task("t1")
    scenario = build_scenario(
        make_state(tasks=[task]),
        plan_of(scheduled_blocks=[ai_block_payload("t1", at(1, 10))]),
        "tasks_only",
        NOW,
    )
    assert any("本地排程模式" in e for e in scenario.errors)


def test_daily_cap_overflow_is_warning_not_error():
    task = make_task("t1", deadline=at(3, 18), est=480)
    plan = plan_of(
        scheduled_blocks=[
            ai_block_payload("t1", at(1, 9), hours=4),
            ai_block_payload("t1", at(1, 13), hours=4),
        ]
    )
    scenario = build_scenario(make_state(tasks=[task], cap=6), plan, "ai_plan", NOW)
    assert not scenario.errors
    assert any("超过每日上限" in w for w in scenario.warnings)


# ---- HTTP endpoints ----


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PLANNER_DB", str(tmp_path / "web.db"))
    return TestClient(app)


def make_task_body(title="Write report"):
    return {
        "title": title,
        "deadline": at(5, 18).isoformat(),
        "estimatedMinutes": 120,
        "priority": "high",
    }


def test_generate_prompt_includes_context_per_mode(client):
    task = client.post("/api/tasks", json=make_task_body()).json()
    for mode in ("ai_plan", "ai_optimize", "tasks_only"):
        prompt = client.post(
            "/api/ai-import/generate-prompt",
            json={"mode": mode, "requirements": "考试周优先复习"},
        ).json()["prompt"]
        assert task["id"] in prompt
        assert "考试周优先复习" in prompt
        assert ai_plan.MODE_LABELS[mode] in prompt
        assert "JSON Schema" in prompt


def test_validate_returns_preview_without_writing(client):
    task = client.post("/api/tasks", json=make_task_body()).json()
    output = json.dumps({"tasks": [{"id": task["id"], "priority": "urgent"}]})
    preview = client.post(
        "/api/ai-import/validate-output", json={"text": output, "mode": "tasks_only"}
    ).json()
    assert preview["ok"] is True
    assert preview["previewVersion"]
    assert preview["summary"] == {"task_update": 1}
    [change] = preview["changes"]
    assert change["fields"] == [{"field": "priority", "old": "high", "new": "urgent"}]
    # preview must not modify the database
    assert client.get("/api/tasks").json()[0]["priority"] == "high"


def test_import_ai_plan_writes_tasks_and_ai_blocks(client):
    output = json.dumps(
        {
            "tasks": [
                {"id": "essay", "title": "论文", "deadline": at(5, 18).isoformat(),
                 "estimated_minutes": 60}
            ],
            "scheduled_blocks": [
                {"task_id": "essay", "start_at": at(2, 10).isoformat(),
                 "end_at": at(2, 11).isoformat()}
            ],
        }
    )
    preview = client.post(
        "/api/ai-import/validate-output", json={"text": output, "mode": "ai_plan"}
    ).json()
    assert preview["ok"], preview["errors"]
    res = client.post(
        "/api/ai-import/import",
        json={"text": output, "mode": "ai_plan",
              "previewVersion": preview["previewVersion"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["applied"] == 2
    assert client.get("/api/tasks").json()[0]["id"] == "essay"
    [block] = client.get("/api/schedule/blocks").json()
    assert block["source"] == "ai"
    assert block["taskId"] == "essay"


def test_import_rejects_stale_preview_version(client):
    output = json.dumps(
        {"tasks": [{"id": "t1", "title": "X", "deadline": at(5, 18).isoformat(),
                    "estimated_minutes": 60}]}
    )
    preview = client.post(
        "/api/ai-import/validate-output", json={"text": output, "mode": "tasks_only"}
    ).json()
    client.post("/api/tasks", json=make_task_body("并发新增"))  # data changes after preview
    res = client.post(
        "/api/ai-import/import",
        json={"text": output, "mode": "tasks_only",
              "previewVersion": preview["previewVersion"]},
    )
    assert res.status_code == 409
    assert all(t["title"] != "X" for t in client.get("/api/tasks").json())


def test_import_tasks_only_runs_local_scheduler(client):
    output = json.dumps(
        {"tasks": [{"id": "t1", "title": "本地排程", "deadline": at(5, 18).isoformat(),
                    "estimated_minutes": 60}]}
    )
    preview = client.post(
        "/api/ai-import/validate-output", json={"text": output, "mode": "tasks_only"}
    ).json()
    res = client.post(
        "/api/ai-import/import",
        json={"text": output, "mode": "tasks_only",
              "previewVersion": preview["previewVersion"]},
    ).json()
    assert res["scheduleSummary"]["createdBlocks"] >= 1
    blocks = client.get("/api/schedule/blocks").json()
    assert blocks and all(b["source"] == "local_auto" for b in blocks)


def test_import_partial_accept_drops_dependent_block(client):
    output = json.dumps(
        {
            "tasks": [
                {"id": "essay", "title": "论文", "deadline": at(5, 18).isoformat(),
                 "estimated_minutes": 60}
            ],
            "scheduled_blocks": [
                {"task_id": "essay", "start_at": at(2, 10).isoformat(),
                 "end_at": at(2, 11).isoformat()}
            ],
        }
    )
    preview = client.post(
        "/api/ai-import/validate-output", json={"text": output, "mode": "ai_plan"}
    ).json()
    res = client.post(
        "/api/ai-import/import",
        json={"text": output, "mode": "ai_plan",
              "previewVersion": preview["previewVersion"],
              "acceptedChangeIds": []},  # reject everything
    ).json()
    assert res["applied"] == 0
    assert client.get("/api/tasks").json() == []
    assert client.get("/api/schedule/blocks").json() == []


def test_import_with_errors_writes_nothing(client):
    output = json.dumps(
        {
            "tasks": [
                {"id": "ok", "title": "正常", "deadline": at(5, 18).isoformat(),
                 "estimated_minutes": 60}
            ],
            "scheduled_blocks": [
                {"task_id": "ghost", "start_at": at(2, 10).isoformat(),
                 "end_at": at(2, 11).isoformat()}  # unknown task -> whole batch fails
            ],
        }
    )
    version = client.post(
        "/api/ai-import/validate-output", json={"text": output, "mode": "ai_plan"}
    ).json()["previewVersion"]
    res = client.post(
        "/api/ai-import/import",
        json={"text": output, "mode": "ai_plan", "previewVersion": version},
    )
    assert res.status_code == 422
    assert client.get("/api/tasks").json() == []
    assert client.get("/api/schedule/blocks").json() == []


def test_user_moving_block_converts_it_to_manual(client):
    client.post("/api/tasks", json=make_task_body())
    client.post("/api/schedule/regenerate")
    block = client.get("/api/schedule/blocks").json()[0]
    assert block["source"] == "local_auto"
    new_start = datetime.fromisoformat(block["startAt"]) + timedelta(minutes=30)
    new_end = datetime.fromisoformat(block["endAt"]) + timedelta(minutes=30)
    moved = client.patch(
        f"/api/schedule/blocks/{block['id']}",
        json={"startAt": new_start.isoformat(), "endAt": new_end.isoformat()},
    ).json()
    assert moved["source"] == "manual"
