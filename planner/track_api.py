"""Task tracking API: checklist, work logs, attachments, AI estimates, career cards.

Mounted by planner.server. Storage follows the same one-JSON-row-per-entity
convention (planner.webdb). File handling rules:

- copy mode: the upload is stored under ``files_root()/<task-id>/`` with a
  generated, sanitized filename; deleting the attachment deletes the copy.
- link mode: only the absolute path is recorded; the original file is never
  copied, served from outside the user's explicit request, or deleted.
"""
from __future__ import annotations

import re
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import Field

from planner import career, estimate_ai, extract
from planner.ai_plan import PlanRejected
from planner.trackmodels import (
    Attachment,
    AttachmentLinkCreate,
    CareerCard,
    CareerCardPatch,
    ChecklistItem,
    ChecklistItemCreate,
    ChecklistItemPatch,
    Estimate,
    TrackingSummary,
    WorkLog,
    WorkLogCreate,
    WorkLogPatch,
)
from planner.webdb import (
    connect,
    delete_row,
    files_root,
    get_one,
    load_all,
    new_id,
    upsert,
)
from planner.webmodels import ScheduleSummary, Task, WebModel

router = APIRouter()

_TRACK_TABLES = {
    "web_task_checklist_items": ChecklistItem,
    "web_task_work_logs": WorkLog,
    "web_task_attachments": Attachment,
    "web_task_estimates": Estimate,
    "web_task_career_cards": CareerCard,
}

MAX_UPLOAD_BYTES = 20 * 1024 * 1024


# ---- request/response bodies ----


class TextBody(WebModel):
    text: str


class EstimatePromptBody(WebModel):
    attachmentIds: list[str] = Field(default_factory=list)


class CareerPromptBody(WebModel):
    attachmentIds: list[str] = Field(default_factory=list)
    confirmedMetrics: str = ""


class ExcerptPreview(WebModel):
    attachmentId: str
    displayName: str
    snippets: list[str] = Field(default_factory=list)


class EstimatePromptResponse(WebModel):
    prompt: str
    excerpts: list[ExcerptPreview] = Field(default_factory=list)


class ApplyEstimateResponse(WebModel):
    task: Task
    estimate: Estimate
    summary: ScheduleSummary


# ---- shared helpers ----


def _require_task(conn: sqlite3.Connection, task_id: str) -> Task:
    task = get_one(conn, "web_tasks", Task, task_id)
    if not task:
        raise HTTPException(404, f"task {task_id} not found")
    return task


def _for_task(conn: sqlite3.Connection, table: str, model: type, task_id: str) -> list:
    return [r for r in load_all(conn, table, model) if r.taskId == task_id]


def _now() -> datetime:
    return datetime.now().astimezone()


def _safe_filename(name: str) -> str:
    base = Path(name).name  # strip any client-sent directory components
    cleaned = re.sub(r"[^\w.\-一-鿿]+", "_", base).strip("._") or "file"
    return cleaned[:80]


def purge_task_data(conn: sqlite3.Connection, task_id: str) -> None:
    """Cascade delete tracking rows and app-managed copies (never linked sources)."""
    for table, model in _TRACK_TABLES.items():
        for record in _for_task(conn, table, model, task_id):
            delete_row(conn, table, record.id)
    task_dir = files_root() / task_id
    if task_dir.is_dir():
        shutil.rmtree(task_dir, ignore_errors=True)


# ---- checklist ----


@router.get("/api/tasks/{task_id}/checklist")
def list_checklist(task_id: str) -> list[ChecklistItem]:
    conn = connect()
    try:
        _require_task(conn, task_id)
        items = _for_task(conn, "web_task_checklist_items", ChecklistItem, task_id)
        return sorted(items, key=lambda i: (i.position, i.createdAt))
    finally:
        conn.close()


@router.post("/api/tasks/{task_id}/checklist")
def create_checklist_item(task_id: str, body: ChecklistItemCreate) -> ChecklistItem:
    conn = connect()
    try:
        _require_task(conn, task_id)
        existing = _for_task(conn, "web_task_checklist_items", ChecklistItem, task_id)
        position = (
            body.position
            if body.position is not None
            else (max((i.position for i in existing), default=-1) + 1)
        )
        item = ChecklistItem(
            id=new_id("chk"),
            taskId=task_id,
            title=body.title,
            position=position,
            createdAt=_now(),
        )
        with conn:
            upsert(conn, "web_task_checklist_items", item.id, item.model_dump_json())
        return item
    finally:
        conn.close()


@router.patch("/api/tasks/{task_id}/checklist/{item_id}")
def patch_checklist_item(
    task_id: str, item_id: str, body: ChecklistItemPatch
) -> ChecklistItem:
    conn = connect()
    try:
        _require_task(conn, task_id)
        existing = get_one(conn, "web_task_checklist_items", ChecklistItem, item_id)
        if not existing or existing.taskId != task_id:
            raise HTTPException(404, f"checklist item {item_id} not found")
        updated = ChecklistItem.model_validate(
            existing.model_dump() | body.model_dump(exclude_unset=True)
        )
        with conn:
            upsert(conn, "web_task_checklist_items", item_id, updated.model_dump_json())
        return updated
    finally:
        conn.close()


@router.delete("/api/tasks/{task_id}/checklist/{item_id}", status_code=204)
def delete_checklist_item(task_id: str, item_id: str) -> None:
    conn = connect()
    try:
        _require_task(conn, task_id)
        existing = get_one(conn, "web_task_checklist_items", ChecklistItem, item_id)
        if not existing or existing.taskId != task_id:
            raise HTTPException(404, f"checklist item {item_id} not found")
        with conn:
            delete_row(conn, "web_task_checklist_items", item_id)
    finally:
        conn.close()


# ---- work logs ----


@router.get("/api/tasks/{task_id}/work-logs")
def list_work_logs(task_id: str) -> list[WorkLog]:
    conn = connect()
    try:
        _require_task(conn, task_id)
        logs = _for_task(conn, "web_task_work_logs", WorkLog, task_id)
        return sorted(logs, key=lambda w: (w.workedAt, w.createdAt))
    finally:
        conn.close()


@router.post("/api/tasks/{task_id}/work-logs")
def create_work_log(task_id: str, body: WorkLogCreate) -> WorkLog:
    conn = connect()
    try:
        _require_task(conn, task_id)
        log = WorkLog(
            **body.model_dump(), id=new_id("wlog"), taskId=task_id, createdAt=_now()
        )
        with conn:
            upsert(conn, "web_task_work_logs", log.id, log.model_dump_json())
        return log
    finally:
        conn.close()


@router.patch("/api/tasks/{task_id}/work-logs/{log_id}")
def patch_work_log(task_id: str, log_id: str, body: WorkLogPatch) -> WorkLog:
    conn = connect()
    try:
        _require_task(conn, task_id)
        existing = get_one(conn, "web_task_work_logs", WorkLog, log_id)
        if not existing or existing.taskId != task_id:
            raise HTTPException(404, f"work log {log_id} not found")
        updated = WorkLog.model_validate(
            existing.model_dump() | body.model_dump(exclude_unset=True)
        )
        with conn:
            upsert(conn, "web_task_work_logs", log_id, updated.model_dump_json())
        return updated
    finally:
        conn.close()


@router.delete("/api/tasks/{task_id}/work-logs/{log_id}", status_code=204)
def delete_work_log(task_id: str, log_id: str) -> None:
    conn = connect()
    try:
        _require_task(conn, task_id)
        existing = get_one(conn, "web_task_work_logs", WorkLog, log_id)
        if not existing or existing.taskId != task_id:
            raise HTTPException(404, f"work log {log_id} not found")
        with conn:
            delete_row(conn, "web_task_work_logs", log_id)
    finally:
        conn.close()


# ---- attachments ----


@router.get("/api/tasks/{task_id}/attachments")
def list_attachments(task_id: str) -> list[Attachment]:
    conn = connect()
    try:
        _require_task(conn, task_id)
        items = _for_task(conn, "web_task_attachments", Attachment, task_id)
        return sorted(items, key=lambda a: a.createdAt)
    finally:
        conn.close()


@router.post("/api/tasks/{task_id}/attachments")
async def upload_attachment(
    task_id: str,
    file: UploadFile = File(...),
    description: Optional[str] = Form(default=None),
) -> Attachment:
    """Copy mode: store an app-managed copy under files_root()/<task-id>/."""
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"file exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit")
    conn = connect()
    try:
        _require_task(conn, task_id)
        attachment_id = new_id("att")
        display_name = _safe_filename(file.filename or "file")
        task_dir = files_root() / task_id
        task_dir.mkdir(parents=True, exist_ok=True)
        stored_name = f"{attachment_id}-{display_name}"
        target = task_dir / stored_name
        target.write_bytes(content)
        status, text = extract.extract_text(target, display_name)
        attachment = Attachment(
            id=attachment_id,
            taskId=task_id,
            displayName=display_name,
            storageMode="copy",
            storedPath=f"{task_id}/{stored_name}",
            mimeType=file.content_type,
            sizeBytes=len(content),
            description=description,
            extractionStatus=status,
            extractedText=text,
            createdAt=_now(),
        )
        with conn:
            upsert(conn, "web_task_attachments", attachment.id, attachment.model_dump_json())
        return attachment
    finally:
        conn.close()


@router.post("/api/tasks/{task_id}/attachments/link")
def link_attachment(task_id: str, body: AttachmentLinkCreate) -> Attachment:
    """Link mode: record the absolute path only; never copy or delete the source."""
    source = Path(body.path).expanduser()
    if not source.is_absolute():
        raise HTTPException(422, "link 模式需要绝对路径")
    if not source.is_file():
        raise HTTPException(422, f"源文件不存在：{source}")
    conn = connect()
    try:
        _require_task(conn, task_id)
        display_name = source.name
        status, text = extract.extract_text(source, display_name)
        attachment = Attachment(
            id=new_id("att"),
            taskId=task_id,
            displayName=display_name,
            storageMode="link",
            originalPath=str(source),
            sizeBytes=source.stat().st_size,
            description=body.description,
            extractionStatus=status,
            extractedText=text,
            createdAt=_now(),
        )
        with conn:
            upsert(conn, "web_task_attachments", attachment.id, attachment.model_dump_json())
        return attachment
    finally:
        conn.close()


def _get_attachment(conn: sqlite3.Connection, task_id: str, attachment_id: str) -> Attachment:
    attachment = get_one(conn, "web_task_attachments", Attachment, attachment_id)
    if not attachment or attachment.taskId != task_id:
        raise HTTPException(404, f"attachment {attachment_id} not found")
    return attachment


def _stored_file(attachment: Attachment) -> Path:
    """Resolve a copy-mode path strictly inside files_root (no traversal)."""
    root = files_root().resolve()
    target = (root / attachment.storedPath).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(400, "invalid stored path")
    return target


@router.get("/api/tasks/{task_id}/attachments/{attachment_id}/content")
def attachment_content(task_id: str, attachment_id: str) -> FileResponse:
    conn = connect()
    try:
        _require_task(conn, task_id)
        attachment = _get_attachment(conn, task_id, attachment_id)
    finally:
        conn.close()
    path = (
        _stored_file(attachment)
        if attachment.storageMode == "copy"
        else Path(attachment.originalPath or "")
    )
    if not path.is_file():
        raise HTTPException(404, "文件不存在或已被移动")
    return FileResponse(path, filename=attachment.displayName)


@router.delete("/api/tasks/{task_id}/attachments/{attachment_id}", status_code=204)
def delete_attachment(task_id: str, attachment_id: str) -> None:
    conn = connect()
    try:
        _require_task(conn, task_id)
        attachment = _get_attachment(conn, task_id, attachment_id)
        if attachment.storageMode == "copy" and attachment.storedPath:
            _stored_file(attachment).unlink(missing_ok=True)
        with conn:
            delete_row(conn, "web_task_attachments", attachment_id)
    finally:
        conn.close()


# ---- AI estimates ----


def _excerpts_for(
    conn: sqlite3.Connection, task_id: str, attachment_ids: list[str]
) -> dict[str, tuple[str, list[extract.Excerpt]]]:
    result: dict[str, tuple[str, list[extract.Excerpt]]] = {}
    for attachment_id in attachment_ids:
        attachment = _get_attachment(conn, task_id, attachment_id)
        if attachment.extractionStatus != "ok" or not attachment.extractedText:
            raise HTTPException(
                422, f"附件「{attachment.displayName}」没有可用的解析文本，无法加入提示词"
            )
        excerpts = extract.select_excerpts(attachment.extractedText, attachment.displayName)
        result[attachment_id] = (attachment.displayName, excerpts)
    return result


def _history_samples(conn: sqlite3.Connection, task: Task) -> list[estimate_ai.HistorySample]:
    samples: list[estimate_ai.HistorySample] = []
    for other in load_all(conn, "web_tasks", Task):
        if other.id == task.id or other.type != task.type or other.status != "completed":
            continue
        logs = _for_task(conn, "web_task_work_logs", WorkLog, other.id)
        actual = sum(w.durationMinutes for w in logs)
        if actual <= 0:
            continue
        checklist = _for_task(conn, "web_task_checklist_items", ChecklistItem, other.id)
        applied = [
            e
            for e in _for_task(conn, "web_task_estimates", Estimate, other.id)
            if e.appliedAt is not None
        ]
        likely = max(applied, key=lambda e: e.appliedAt).likelyMinutes if applied else None
        # Completion time isn't stored; "worked past the deadline" approximates overdue.
        overdue = bool(other.deadline) and any(
            w.workedAt > other.deadline.date() for w in logs
        )
        samples.append(
            estimate_ai.HistorySample(
                title=other.title,
                type=other.type,
                estimatedMinutes=other.estimatedMinutes,
                likelyMinutes=likely,
                actualMinutes=actual,
                checklistCount=len(checklist),
                overdue=overdue,
            )
        )
    return samples


@router.post("/api/tasks/{task_id}/estimate-prompt")
def estimate_prompt(task_id: str, body: EstimatePromptBody) -> EstimatePromptResponse:
    conn = connect()
    try:
        task = _require_task(conn, task_id)
        excerpts = _excerpts_for(conn, task_id, body.attachmentIds)
        prompt = estimate_ai.build_estimate_prompt(
            task=task,
            checklist=_for_task(conn, "web_task_checklist_items", ChecklistItem, task_id),
            worklogs=_for_task(conn, "web_task_work_logs", WorkLog, task_id),
            excerpts_by_attachment=excerpts,
            history=_history_samples(conn, task),
            now=_now(),
        )
    finally:
        conn.close()
    previews = [
        ExcerptPreview(
            attachmentId=attachment_id,
            displayName=name,
            snippets=[e.text for e in items],
        )
        for attachment_id, (name, items) in excerpts.items()
    ]
    return EstimatePromptResponse(prompt=prompt, excerpts=previews)


def _extract_estimate_or_422(text: str) -> estimate_ai.EstimateResult:
    try:
        return estimate_ai.extract_estimate(text)
    except PlanRejected as exc:
        raise HTTPException(422, detail={"errors": exc.errors})


def _check_estimate_attachments(
    conn: sqlite3.Connection, task_id: str, result: estimate_ai.EstimateResult
) -> None:
    valid_ids = {
        a.id for a in _for_task(conn, "web_task_attachments", Attachment, task_id)
    }
    unknown = [i for i in result.used_attachment_ids if i not in valid_ids]
    if unknown:
        raise HTTPException(
            422, detail={"errors": [f"used_attachment_ids 引用了不存在的附件：{unknown}"]}
        )


def _estimate_from_result(
    task_id: str, result: estimate_ai.EstimateResult
) -> Estimate:
    return Estimate(
        id=new_id("est"),
        taskId=task_id,
        optimisticMinutes=result.optimistic_minutes,
        likelyMinutes=result.likely_minutes,
        pessimisticMinutes=result.pessimistic_minutes,
        confidence=result.confidence,
        breakdown=result.breakdown,
        assumptions=result.assumptions,
        risks=result.risks,
        sourceAttachmentIds=result.used_attachment_ids,
        createdAt=_now(),
    )


@router.get("/api/tasks/{task_id}/estimates")
def list_estimates(task_id: str) -> list[Estimate]:
    conn = connect()
    try:
        _require_task(conn, task_id)
        estimates = _for_task(conn, "web_task_estimates", Estimate, task_id)
        return sorted(estimates, key=lambda e: e.createdAt, reverse=True)
    finally:
        conn.close()


@router.post("/api/tasks/{task_id}/estimates/validate")
def validate_estimate(task_id: str, body: TextBody) -> Estimate:
    """Parse and check the pasted reply without saving anything."""
    result = _extract_estimate_or_422(body.text)
    conn = connect()
    try:
        _require_task(conn, task_id)
        _check_estimate_attachments(conn, task_id, result)
    finally:
        conn.close()
    return _estimate_from_result(task_id, result)


@router.post("/api/tasks/{task_id}/estimates/import")
def import_estimate(task_id: str, body: TextBody) -> Estimate:
    """Save one estimate history record. Never touches estimatedMinutes."""
    result = _extract_estimate_or_422(body.text)
    conn = connect()
    try:
        _require_task(conn, task_id)
        _check_estimate_attachments(conn, task_id, result)
        estimate = _estimate_from_result(task_id, result)
        with conn:
            upsert(conn, "web_task_estimates", estimate.id, estimate.model_dump_json())
        return estimate
    finally:
        conn.close()


@router.post("/api/tasks/{task_id}/estimates/{estimate_id}/apply")
def apply_estimate(task_id: str, estimate_id: str) -> ApplyEstimateResponse:
    """Write likelyMinutes into the task and re-run the deterministic scheduler."""
    from planner.server import _regenerate  # late import: server mounts this router

    conn = connect()
    try:
        task = _require_task(conn, task_id)
        estimate = get_one(conn, "web_task_estimates", Estimate, estimate_id)
        if not estimate or estimate.taskId != task_id:
            raise HTTPException(404, f"estimate {estimate_id} not found")
        updated_task = task.model_copy(update={"estimatedMinutes": estimate.likelyMinutes})
        updated_estimate = estimate.model_copy(update={"appliedAt": _now()})
        with conn:
            upsert(conn, "web_tasks", task_id, updated_task.model_dump_json())
            upsert(
                conn,
                "web_task_estimates",
                estimate_id,
                updated_estimate.model_dump_json(),
            )
        summary = _regenerate(conn)
        return ApplyEstimateResponse(
            task=updated_task, estimate=updated_estimate, summary=summary
        )
    finally:
        conn.close()


# ---- career card (one per task) ----


@router.post("/api/tasks/{task_id}/career-card-prompt")
def career_card_prompt(task_id: str, body: CareerPromptBody) -> dict:
    conn = connect()
    try:
        task = _require_task(conn, task_id)
        prompt = career.build_career_prompt(
            task=task,
            checklist=_for_task(conn, "web_task_checklist_items", ChecklistItem, task_id),
            worklogs=_for_task(conn, "web_task_work_logs", WorkLog, task_id),
            excerpts_by_attachment=_excerpts_for(conn, task_id, body.attachmentIds),
            confirmed_metrics=body.confirmedMetrics,
            now=_now(),
        )
        return {"prompt": prompt}
    finally:
        conn.close()


def _extract_card_or_422(text: str) -> career.CareerCardResult:
    try:
        return career.extract_card(text)
    except PlanRejected as exc:
        raise HTTPException(422, detail={"errors": exc.errors})


def _check_card_evidence(
    conn: sqlite3.Connection, task_id: str, result: career.CareerCardResult
) -> None:
    valid_ids = {
        a.id for a in _for_task(conn, "web_task_attachments", Attachment, task_id)
    }
    unknown = [i for i in result.evidence_attachment_ids if i not in valid_ids]
    if unknown:
        raise HTTPException(
            422,
            detail={"errors": [f"evidence_attachment_ids 引用了不存在的附件：{unknown}"]},
        )


def _card_from_result(
    task_id: str, result: career.CareerCardResult, created_at: datetime
) -> CareerCard:
    now = _now()
    return CareerCard(
        id=f"career-{task_id}",
        taskId=task_id,
        context=result.context,
        role=result.role,
        actions=result.actions,
        challenges=result.challenges,
        outcomes=result.outcomes,
        metrics=result.metrics,
        skills=result.skills,
        evidenceAttachmentIds=result.evidence_attachment_ids,
        createdAt=created_at,
        updatedAt=now,
    )


@router.post("/api/tasks/{task_id}/career-cards/validate")
def validate_career_card(task_id: str, body: TextBody) -> CareerCard:
    result = _extract_card_or_422(body.text)
    conn = connect()
    try:
        _require_task(conn, task_id)
        _check_card_evidence(conn, task_id, result)
    finally:
        conn.close()
    return _card_from_result(task_id, result, _now())


@router.post("/api/tasks/{task_id}/career-cards/import")
def import_career_card(task_id: str, body: TextBody) -> CareerCard:
    """Save the task's single card; re-importing replaces it."""
    result = _extract_card_or_422(body.text)
    conn = connect()
    try:
        _require_task(conn, task_id)
        _check_card_evidence(conn, task_id, result)
        existing = get_one(conn, "web_task_career_cards", CareerCard, f"career-{task_id}")
        card = _card_from_result(
            task_id, result, existing.createdAt if existing else _now()
        )
        with conn:
            upsert(conn, "web_task_career_cards", card.id, card.model_dump_json())
        return card
    finally:
        conn.close()


@router.get("/api/tasks/{task_id}/career-card")
def get_career_card(task_id: str) -> CareerCard:
    conn = connect()
    try:
        _require_task(conn, task_id)
        card = get_one(conn, "web_task_career_cards", CareerCard, f"career-{task_id}")
        if not card:
            raise HTTPException(404, "该任务还没有职业素材卡")
        return card
    finally:
        conn.close()


@router.patch("/api/tasks/{task_id}/career-card")
def patch_career_card(task_id: str, body: CareerCardPatch) -> CareerCard:
    conn = connect()
    try:
        _require_task(conn, task_id)
        existing = get_one(conn, "web_task_career_cards", CareerCard, f"career-{task_id}")
        if not existing:
            raise HTTPException(404, "该任务还没有职业素材卡")
        updated = CareerCard.model_validate(
            existing.model_dump()
            | body.model_dump(exclude_unset=True)
            | {"updatedAt": _now()}
        )
        with conn:
            upsert(conn, "web_task_career_cards", updated.id, updated.model_dump_json())
        return updated
    finally:
        conn.close()


@router.get("/api/tasks/{task_id}/career-card/export.md")
def export_career_card(task_id: str) -> PlainTextResponse:
    conn = connect()
    try:
        task = _require_task(conn, task_id)
        card = get_one(conn, "web_task_career_cards", CareerCard, f"career-{task_id}")
        if not card:
            raise HTTPException(404, "该任务还没有职业素材卡")
    finally:
        conn.close()
    return PlainTextResponse(
        career.card_to_markdown(card, task), media_type="text/markdown; charset=utf-8"
    )


# ---- aggregated summary for the task list page ----


@router.get("/api/tracking-summary")
def tracking_summary() -> list[TrackingSummary]:
    conn = connect()
    try:
        tasks = load_all(conn, "web_tasks", Task)
        checklist = load_all(conn, "web_task_checklist_items", ChecklistItem)
        worklogs = load_all(conn, "web_task_work_logs", WorkLog)
        attachments = load_all(conn, "web_task_attachments", Attachment)
    finally:
        conn.close()
    summaries: list[TrackingSummary] = []
    for task in tasks:
        items = [c for c in checklist if c.taskId == task.id]
        summaries.append(
            TrackingSummary(
                taskId=task.id,
                checklistDone=sum(1 for c in items if c.completed),
                checklistTotal=len(items),
                actualMinutes=sum(
                    w.durationMinutes for w in worklogs if w.taskId == task.id
                ),
                attachmentCount=sum(1 for a in attachments if a.taskId == task.id),
            )
        )
    return summaries
