import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

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


def make_task(client, **overrides):
    body = {
        "title": "Write report",
        "type": "assignment",
        "deadline": iso(future(days=5)),
        "estimatedMinutes": 120,
        "priority": "high",
        "splittable": True,
    }
    body.update(overrides)
    return client.post("/api/tasks", json=body).json()


def estimate_reply(**overrides):
    data = {
        "optimistic_minutes": 60,
        "likely_minutes": 90,
        "pessimistic_minutes": 150,
        "confidence": "medium",
        "breakdown": [{"step": "写大纲", "minutes": 30}, {"step": "成稿", "minutes": 60}],
        "assumptions": ["资料齐全"],
        "risks": ["需要额外查文献"],
        "used_attachment_ids": [],
    }
    data.update(overrides)
    return json.dumps(data, ensure_ascii=False)


def card_reply(**overrides):
    data = {
        "context": "课程项目需要在两周内交付报告",
        "role": "独立完成全部工作",
        "actions": ["拆解需求", "实现功能"],
        "challenges": ["时间紧"],
        "outcomes": ["按期交付"],
        "metrics": ["待补充"],
        "skills": ["Python"],
        "evidence_attachment_ids": [],
    }
    data.update(overrides)
    return json.dumps(data, ensure_ascii=False)


# ---- checklist ----


def test_checklist_crud_and_ordering(client):
    task = make_task(client)
    url = f"/api/tasks/{task['id']}/checklist"
    first = client.post(url, json={"title": "写大纲"}).json()
    second = client.post(url, json={"title": "写正文"}).json()
    assert [i["position"] for i in (first, second)] == [0, 1]

    done = client.patch(f"{url}/{first['id']}", json={"completed": True}).json()
    assert done["completed"] is True

    assert client.delete(f"{url}/{second['id']}").status_code == 204
    titles = [i["title"] for i in client.get(url).json()]
    assert titles == ["写大纲"]


def test_checklist_missing_task_and_bad_input(client):
    assert client.get("/api/tasks/nope/checklist").status_code == 404
    task = make_task(client)
    url = f"/api/tasks/{task['id']}/checklist"
    assert client.post(url, json={"title": ""}).status_code == 422
    assert client.post(url, json={"title": "x", "extra": 1}).status_code == 422
    assert client.patch(f"{url}/missing", json={"completed": True}).status_code == 404


# ---- work logs ----


def test_work_log_crud_and_validation(client):
    task = make_task(client)
    url = f"/api/tasks/{task['id']}/work-logs"
    log = client.post(
        url,
        json={"workedAt": "2026-06-10", "durationMinutes": 45, "summary": "写了大纲"},
    ).json()
    assert log["durationMinutes"] == 45

    patched = client.patch(f"{url}/{log['id']}", json={"durationMinutes": 60}).json()
    assert patched["durationMinutes"] == 60

    assert (
        client.post(
            url, json={"workedAt": "2026-06-10", "durationMinutes": 0, "summary": "x"}
        ).status_code
        == 422
    )
    assert client.delete(f"{url}/{log['id']}").status_code == 204
    assert client.get(url).json() == []


def test_tracking_summary_counts_only_work_logs(client):
    task = make_task(client)
    # scheduled blocks must NOT count as actual time
    client.post("/api/schedule/regenerate")
    client.post(
        f"/api/tasks/{task['id']}/work-logs",
        json={"workedAt": "2026-06-10", "durationMinutes": 30, "summary": "a"},
    )
    client.post(
        f"/api/tasks/{task['id']}/work-logs",
        json={"workedAt": "2026-06-11", "durationMinutes": 40, "summary": "b"},
    )
    client.post(f"/api/tasks/{task['id']}/checklist", json={"title": "step"})
    summary = client.get("/api/tracking-summary").json()
    row = next(s for s in summary if s["taskId"] == task["id"])
    assert row["actualMinutes"] == 70
    assert row["checklistTotal"] == 1
    assert row["checklistDone"] == 0


# ---- attachments ----


def upload_md(client, task_id, name="spec.md", content="## 交付要求\n\n必须提交 3 份文档。"):
    return client.post(
        f"/api/tasks/{task_id}/attachments",
        files={"file": (name, content.encode("utf-8"), "text/markdown")},
    )


def test_copy_attachment_upload_extract_content_delete(client, tmp_path):
    task = make_task(client)
    att = upload_md(client, task["id"]).json()
    assert att["storageMode"] == "copy"
    assert att["extractionStatus"] == "ok"
    assert "交付要求" in att["extractedText"]

    stored = tmp_path / "files" / att["storedPath"]
    assert stored.is_file()

    content = client.get(f"/api/tasks/{task['id']}/attachments/{att['id']}/content")
    assert content.status_code == 200
    assert "必须提交" in content.text

    assert (
        client.delete(f"/api/tasks/{task['id']}/attachments/{att['id']}").status_code
        == 204
    )
    assert not stored.exists()


def test_upload_sanitizes_traversal_filename(client, tmp_path):
    task = make_task(client)
    att = upload_md(client, task["id"], name="../../evil.md").json()
    assert "/" not in att["displayName"]
    assert ".." not in att["displayName"]
    stored = (tmp_path / "files" / att["storedPath"]).resolve()
    assert stored.is_relative_to((tmp_path / "files").resolve())


def test_link_attachment_keeps_source_on_delete(client, tmp_path):
    source = tmp_path / "源文件.txt"
    source.write_text("需求：完成验收", encoding="utf-8")
    task = make_task(client)
    att = client.post(
        f"/api/tasks/{task['id']}/attachments/link", json={"path": str(source)}
    ).json()
    assert att["storageMode"] == "link"
    assert att["extractionStatus"] == "ok"

    client.delete(f"/api/tasks/{task['id']}/attachments/{att['id']}")
    assert source.exists()  # link mode never deletes the original


def test_link_attachment_rejects_missing_or_relative_path(client, tmp_path):
    task = make_task(client)
    url = f"/api/tasks/{task['id']}/attachments/link"
    assert client.post(url, json={"path": str(tmp_path / "ghost.txt")}).status_code == 422
    assert client.post(url, json={"path": "relative.txt"}).status_code == 422


def test_unparseable_upload_kept_with_failed_status(client):
    task = make_task(client)
    res = client.post(
        f"/api/tasks/{task['id']}/attachments",
        files={"file": ("scan.pdf", b"not a pdf", "application/pdf")},
    )
    att = res.json()
    assert att["extractionStatus"] == "failed"
    assert client.get(f"/api/tasks/{task['id']}/attachments").json()[0]["id"] == att["id"]


# ---- estimates ----


def test_estimate_prompt_includes_excerpts_and_history(client):
    done = make_task(client, title="旧报告", status="completed")
    client.post(
        f"/api/tasks/{done['id']}/work-logs",
        json={"workedAt": "2026-06-01", "durationMinutes": 100, "summary": "完成"},
    )
    task = make_task(client)
    att = upload_md(client, task["id"]).json()
    res = client.post(
        f"/api/tasks/{task['id']}/estimate-prompt", json={"attachmentIds": [att["id"]]}
    ).json()
    assert "必须提交 3 份文档" in res["prompt"]
    assert "旧报告" in res["prompt"]  # history sample of the same type
    assert res["excerpts"][0]["attachmentId"] == att["id"]


def test_estimate_prompt_rejects_failed_attachment(client):
    task = make_task(client)
    att = client.post(
        f"/api/tasks/{task['id']}/attachments",
        files={"file": ("scan.pdf", b"junk", "application/pdf")},
    ).json()
    res = client.post(
        f"/api/tasks/{task['id']}/estimate-prompt", json={"attachmentIds": [att["id"]]}
    )
    assert res.status_code == 422


def test_estimate_validation_rules(client):
    task = make_task(client)
    base = f"/api/tasks/{task['id']}/estimates"
    # interval order violated
    bad = estimate_reply(optimistic_minutes=200)
    assert client.post(f"{base}/validate", json={"text": bad}).status_code == 422
    # extra fields rejected
    extra = json.dumps({**json.loads(estimate_reply()), "surprise": 1})
    assert client.post(f"{base}/validate", json={"text": extra}).status_code == 422
    # unknown attachment id rejected
    ghost = estimate_reply(used_attachment_ids=["att-ghost"])
    assert client.post(f"{base}/validate", json={"text": ghost}).status_code == 422
    # valid reply embedded in prose passes
    ok = client.post(
        f"{base}/validate", json={"text": f"分析如下：\n```json\n{estimate_reply()}\n```"}
    )
    assert ok.status_code == 200
    assert ok.json()["likelyMinutes"] == 90


def test_import_estimate_does_not_change_schedule_or_task(client):
    task = make_task(client)
    est = client.post(
        f"/api/tasks/{task['id']}/estimates/import", json={"text": estimate_reply()}
    ).json()
    assert est["appliedAt"] is None
    tasks = client.get("/api/tasks").json()
    assert tasks[0]["estimatedMinutes"] == 120  # unchanged until applied
    history = client.get(f"/api/tasks/{task['id']}/estimates").json()
    assert [e["id"] for e in history] == [est["id"]]


def test_apply_estimate_updates_task_and_reschedules(client):
    task = make_task(client)
    est = client.post(
        f"/api/tasks/{task['id']}/estimates/import", json={"text": estimate_reply()}
    ).json()
    res = client.post(f"/api/tasks/{task['id']}/estimates/{est['id']}/apply").json()
    assert res["task"]["estimatedMinutes"] == 90
    assert res["estimate"]["appliedAt"] is not None
    blocks = client.get("/api/schedule/blocks").json()
    total = sum(
        (datetime.fromisoformat(b["endAt"]) - datetime.fromisoformat(b["startAt"]))
        // timedelta(minutes=1)
        for b in blocks
    )
    assert total == 90
    # history record kept with original interval
    history = client.get(f"/api/tasks/{task['id']}/estimates").json()
    assert history[0]["pessimisticMinutes"] == 150


# ---- career card ----


def test_career_card_import_edit_export(client):
    task = make_task(client)
    base = f"/api/tasks/{task['id']}"
    assert client.get(f"{base}/career-card").status_code == 404

    prompt = client.post(f"{base}/career-card-prompt", json={}).json()["prompt"]
    assert "职业素材" in prompt

    card = client.post(f"{base}/career-cards/import", json={"text": card_reply()}).json()
    assert card["metrics"] == ["待补充"]

    patched = client.patch(f"{base}/career-card", json={"metrics": ["10 个测试通过"]}).json()
    assert patched["metrics"] == ["10 个测试通过"]

    md = client.get(f"{base}/career-card/export.md")
    assert md.status_code == 200
    assert "# 职业素材卡：Write report" in md.text
    assert "10 个测试通过" in md.text


def test_career_card_rejects_extra_fields_and_ghost_evidence(client):
    task = make_task(client)
    base = f"/api/tasks/{task['id']}/career-cards"
    extra = json.dumps({**json.loads(card_reply()), "resume": "全文"})
    assert client.post(f"{base}/validate", json={"text": extra}).status_code == 422
    ghost = card_reply(evidence_attachment_ids=["att-ghost"])
    assert client.post(f"{base}/validate", json={"text": ghost}).status_code == 422


# ---- cascade delete ----


def test_delete_task_purges_tracking_data_but_keeps_linked_file(client, tmp_path):
    source = tmp_path / "evidence.txt"
    source.write_text("需求文档", encoding="utf-8")
    task = make_task(client)
    base = f"/api/tasks/{task['id']}"
    client.post(f"{base}/checklist", json={"title": "step"})
    client.post(
        f"{base}/work-logs",
        json={"workedAt": "2026-06-10", "durationMinutes": 30, "summary": "x"},
    )
    copied = upload_md(client, task["id"]).json()
    client.post(f"{base}/attachments/link", json={"path": str(source)})
    client.post(f"{base}/estimates/import", json={"text": estimate_reply()})
    client.post(f"{base}/career-cards/import", json={"text": card_reply()})

    assert client.delete(base).status_code == 204

    assert source.exists()  # linked original untouched
    assert not (tmp_path / "files" / copied["storedPath"]).exists()
    summary = client.get("/api/tracking-summary").json()
    assert summary == []
    # tracking endpoints now 404 because the task is gone
    assert client.get(f"{base}/checklist").status_code == 404
