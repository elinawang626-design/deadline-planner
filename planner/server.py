"""FastAPI HTTP layer for the web frontend.

Speaks the frontend's JSON shapes directly (camelCase, datetimes as ISO 8601
with offsets, weekday in the JS getDay() convention: 0 = Sunday). Web entities
are stored in their own SQLite tables (web_*) inside the same database file as
the CLI, so the two workflows never corrupt each other.

Run with: planner-server  (or: python3 -m uvicorn planner.server:app)
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, time, timedelta
from math import ceil
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from planner.importer import ImportRejected, _extract_json_text
from planner.models import _require_tz

HORIZON_DAYS = 14
DEFAULT_WINDOW = ("09:00", "17:00")
DEFAULT_MAX_PLANNED_HOURS = 6
PRIORITY_RANK = {"urgent": 0, "high": 1, "medium": 2, "low": 3}

Priority = Literal["low", "medium", "high", "urgent"]
TaskType = Literal[
    "assignment", "exam", "project", "admin", "personal", "research", "coding", "other"
]
TaskStatus = Literal["active", "completed", "archived"]
BlockSource = Literal["auto", "manual"]


class WebModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PreferredWindow(WebModel):
    weekday: int = Field(ge=0, le=6)  # 0 = Sunday (JS convention)
    startTime: str
    endTime: str


class Task(WebModel):
    id: str
    title: str
    description: Optional[str] = None
    type: TaskType = "other"
    deadline: datetime
    estimatedMinutes: int = Field(gt=0)
    earliestStartAt: Optional[datetime] = None
    priority: Priority = "medium"
    splittable: bool = True
    minBlockMinutes: Optional[int] = None
    maxBlockMinutes: Optional[int] = None
    preferredWindows: Optional[list[PreferredWindow]] = None
    notes: Optional[str] = None
    status: TaskStatus = "active"
    createdAt: datetime

    _tz = field_validator("deadline", "earliestStartAt", "createdAt")(
        classmethod(lambda cls, v: None if v is None else _require_tz(v))
    )


class TaskCreate(WebModel):
    title: str
    description: Optional[str] = None
    type: TaskType = "other"
    deadline: datetime
    estimatedMinutes: int = Field(gt=0)
    earliestStartAt: Optional[datetime] = None
    priority: Priority = "medium"
    splittable: bool = True
    minBlockMinutes: Optional[int] = None
    maxBlockMinutes: Optional[int] = None
    preferredWindows: Optional[list[PreferredWindow]] = None
    notes: Optional[str] = None
    status: TaskStatus = "active"


class TaskPatch(WebModel):
    title: Optional[str] = None
    description: Optional[str] = None
    type: Optional[TaskType] = None
    deadline: Optional[datetime] = None
    estimatedMinutes: Optional[int] = None
    earliestStartAt: Optional[datetime] = None
    priority: Optional[Priority] = None
    splittable: Optional[bool] = None
    minBlockMinutes: Optional[int] = None
    maxBlockMinutes: Optional[int] = None
    preferredWindows: Optional[list[PreferredWindow]] = None
    notes: Optional[str] = None
    status: Optional[TaskStatus] = None


class ScheduledBlock(WebModel):
    id: str
    taskId: str
    startAt: datetime
    endAt: datetime
    locked: bool = False
    source: BlockSource = "auto"
    done: bool = False
    notes: Optional[str] = None

    _tz = field_validator("startAt", "endAt")(classmethod(lambda cls, v: _require_tz(v)))


class BlockPatch(WebModel):
    startAt: Optional[datetime] = None
    endAt: Optional[datetime] = None
    locked: Optional[bool] = None
    source: Optional[BlockSource] = None
    done: Optional[bool] = None
    notes: Optional[str] = None


class AvailabilityWindow(WebModel):
    id: str
    weekday: int = Field(ge=0, le=6)
    startTime: str
    endTime: str


class AvailabilityCreate(WebModel):
    weekday: int = Field(ge=0, le=6)
    startTime: str
    endTime: str


class AvailabilityPatch(WebModel):
    weekday: Optional[int] = Field(default=None, ge=0, le=6)
    startTime: Optional[str] = None
    endTime: Optional[str] = None


class FixedEvent(WebModel):
    id: str
    title: str
    startAt: datetime
    endAt: datetime


class Settings(WebModel):
    dailyMaxPlannedHours: int = Field(gt=0, le=24)


class ScheduleWarning(WebModel):
    type: str
    message: str
    taskId: Optional[str] = None


class ScheduleSummary(WebModel):
    createdBlocks: int
    removedBlocks: int
    unscheduledTaskIds: list[str]
    warnings: list[ScheduleWarning]


# ---- AI import (mirrors the CLI's strict manual-LLM workflow) ----


class LlmTask(WebModel):
    id: Optional[str] = None
    title: str
    deadline: datetime
    estimated_hours: int = Field(gt=0)
    priority: Literal["high", "medium", "low"]
    earliest_start_at: Optional[datetime] = None

    _tz = field_validator("deadline", "earliest_start_at")(
        classmethod(lambda cls, v: None if v is None else _require_tz(v))
    )


class LlmOutput(WebModel):
    tasks: list[LlmTask]


class RawInputBody(WebModel):
    rawInput: str


class TextBody(WebModel):
    text: str


# ---- storage ----

_TABLES = ["web_tasks", "web_blocks", "web_availability", "web_fixed_events", "web_settings"]


def _db_path() -> Path:
    return Path(os.environ.get("PLANNER_DB", ".planner/planner.db"))


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    for table in _TABLES:
        conn.execute(f"CREATE TABLE IF NOT EXISTS {table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    return conn


def _load_all(conn: sqlite3.Connection, table: str, model: type) -> list:
    rows = conn.execute(f"SELECT data FROM {table} ORDER BY id").fetchall()
    return [model.model_validate_json(row[0]) for row in rows]


def _upsert(conn: sqlite3.Connection, table: str, entity_id: str, data: str) -> None:
    conn.execute(
        f"INSERT INTO {table} (id, data) VALUES (?, ?) "
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        (entity_id, data),
    )


def _delete_row(conn: sqlite3.Connection, table: str, entity_id: str) -> None:
    conn.execute(f"DELETE FROM {table} WHERE id = ?", (entity_id,))


def _get(conn: sqlite3.Connection, table: str, model: type, entity_id: str):
    row = conn.execute(f"SELECT data FROM {table} WHERE id = ?", (entity_id,)).fetchone()
    return model.model_validate_json(row[0]) if row else None


def _new_id(prefix: str) -> str:
    return f"{prefix}-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"


# ---- deterministic scheduler (same rules as the frontend mock) ----


def _ceil_hour(dt: datetime) -> datetime:
    if dt.minute or dt.second or dt.microsecond:
        return dt.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return dt


def _minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def _js_weekday(dt: datetime) -> int:
    return (dt.weekday() + 1) % 7  # Python Mon=0 -> JS Sun=0


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and b_start < a_end


def _regenerate(conn: sqlite3.Connection) -> ScheduleSummary:
    now = datetime.now().astimezone()
    tz = now.tzinfo
    horizon_start = _ceil_hour(now)
    horizon_end = now + timedelta(days=HORIZON_DAYS)

    tasks: list[Task] = _load_all(conn, "web_tasks", Task)
    blocks: list[ScheduledBlock] = _load_all(conn, "web_blocks", ScheduledBlock)
    availability: list[AvailabilityWindow] = _load_all(conn, "web_availability", AvailabilityWindow)
    events: list[FixedEvent] = _load_all(conn, "web_fixed_events", FixedEvent)
    settings = _get(conn, "web_settings", Settings, "settings") or Settings(
        dailyMaxPlannedHours=DEFAULT_MAX_PLANNED_HOURS
    )

    removed_ids = {
        b.id
        for b in blocks
        if b.source == "auto" and not b.locked and not b.done and b.startAt >= now
    }
    kept = [b for b in blocks if b.id not in removed_ids]

    busy = [(e.startAt, e.endAt) for e in events] + [(b.startAt, b.endAt) for b in kept]

    slot_map: dict[float, datetime] = {}
    for offset in range(HORIZON_DAYS + 1):
        day = (now + timedelta(days=offset)).date()
        windows = [
            (w.startTime, w.endTime)
            for w in availability
            if w.weekday == _js_weekday(datetime.combine(day, time(), tzinfo=tz))
        ] or [DEFAULT_WINDOW]
        for start_str, end_str in windows:
            end_min = _minutes(end_str)
            hour = ceil(_minutes(start_str) / 60)
            while (hour + 1) * 60 <= end_min and hour < 24:
                slot_start = datetime.combine(day, time(hour), tzinfo=tz)
                slot_end = slot_start + timedelta(hours=1)
                if (
                    slot_start >= horizon_start
                    and slot_end <= horizon_end
                    and not any(_overlaps(slot_start, slot_end, s, e) for s, e in busy)
                ):
                    slot_map[slot_start.timestamp()] = slot_start
                hour += 1
    free = [slot_map[key] for key in sorted(slot_map)]

    warnings: list[ScheduleWarning] = []
    unscheduled: list[str] = []
    created: list[ScheduledBlock] = []
    used: set[float] = set()

    active = sorted(
        (t for t in tasks if t.status == "active"),
        key=lambda t: (t.deadline, PRIORITY_RANK[t.priority], t.id),
    )

    for task in active:
        if task.deadline > horizon_end:
            warnings.append(
                ScheduleWarning(
                    type="deadline_unreachable",
                    taskId=task.id,
                    message=f"任务「{task.title}」截止日超出 {HORIZON_DAYS} 天调度范围，仅安排范围内时段",
                )
            )

        planned_minutes = sum(
            (b.endAt - b.startAt).total_seconds() / 60 for b in kept if b.taskId == task.id
        )
        needed_hours = ceil(max(0, task.estimatedMinutes - planned_minutes) / 60)
        if needed_hours == 0:
            continue

        eligible = [
            s
            for s in free
            if s.timestamp() not in used
            and (task.earliestStartAt is None or s >= task.earliestStartAt)
            and s + timedelta(hours=1) <= task.deadline
        ]

        def matches_preferred(slot: datetime) -> bool:
            for window in task.preferredWindows or []:
                if (
                    window.weekday == _js_weekday(slot)
                    and slot.hour * 60 >= _minutes(window.startTime)
                    and (slot.hour + 1) * 60 <= _minutes(window.endTime)
                ):
                    return True
            return False

        picks: list[datetime] = []
        if not task.splittable and needed_hours > 1:
            for i in range(len(eligible) - needed_hours + 1):
                run = eligible[i : i + needed_hours]
                if all(
                    (run[k] - run[k - 1]) == timedelta(hours=1) for k in range(1, len(run))
                ):
                    picks = run
                    break
            if not picks:
                warnings.append(
                    ScheduleWarning(
                        type="insufficient_time",
                        taskId=task.id,
                        message=f"任务「{task.title}」不可拆分，且截止前找不到连续 {needed_hours} 小时空档",
                    )
                )
                unscheduled.append(task.id)
                continue
        else:
            if task.preferredWindows:
                preferred = [s for s in eligible if matches_preferred(s)]
                rest = [s for s in eligible if not matches_preferred(s)]
                eligible = preferred + rest
            picks = eligible[:needed_hours]

        if not picks:
            warnings.append(
                ScheduleWarning(
                    type="deadline_unreachable",
                    taskId=task.id,
                    message=f"任务「{task.title}」在截止前没有可用空档",
                )
            )
            unscheduled.append(task.id)
            continue
        if len(picks) < needed_hours:
            warnings.append(
                ScheduleWarning(
                    type="insufficient_time",
                    taskId=task.id,
                    message=f"任务「{task.title}」只安排了 {len(picks)}/{needed_hours} 小时",
                )
            )

        for slot in picks:
            used.add(slot.timestamp())
            created.append(
                ScheduledBlock(
                    id=f"auto-{task.id}-{slot.strftime('%Y%m%dT%H%M%z')}",
                    taskId=task.id,
                    startAt=slot,
                    endAt=slot + timedelta(hours=1),
                    locked=False,
                    source="auto",
                    done=False,
                )
            )

    all_blocks = kept + created

    hours_by_day: dict[str, float] = {}
    for block in all_blocks:
        key = block.startAt.astimezone(tz).strftime("%Y-%m-%d")
        hours_by_day[key] = (
            hours_by_day.get(key, 0) + (block.endAt - block.startAt).total_seconds() / 3600
        )
    for day_key, hours in sorted(hours_by_day.items()):
        if hours > settings.dailyMaxPlannedHours:
            warnings.append(
                ScheduleWarning(
                    type="overloaded_day",
                    message=f"{day_key} 计划 {hours:.1f} 小时，超过每日上限 {settings.dailyMaxPlannedHours} 小时",
                )
            )

    pinned = [b for b in kept if b.locked or b.source == "manual"]
    for i in range(len(pinned)):
        for j in range(i + 1, len(pinned)):
            if _overlaps(pinned[i].startAt, pinned[i].endAt, pinned[j].startAt, pinned[j].endAt):
                warnings.append(
                    ScheduleWarning(
                        type="overlap",
                        message=(
                            "两个手动/锁定块重叠："
                            f"{pinned[i].startAt.astimezone(tz):%m-%d %H:%M} 与 "
                            f"{pinned[j].startAt.astimezone(tz):%m-%d %H:%M}"
                        ),
                    )
                )

    with conn:
        for block_id in removed_ids:
            _delete_row(conn, "web_blocks", block_id)
        for block in created:
            _upsert(conn, "web_blocks", block.id, block.model_dump_json())

    return ScheduleSummary(
        createdBlocks=len(created),
        removedBlocks=len(removed_ids),
        unscheduledTaskIds=unscheduled,
        warnings=warnings,
    )


# ---- app & routes ----

app = FastAPI(title="Deadline Planner API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/tasks")
def list_tasks() -> list[Task]:
    conn = _connect()
    try:
        return _load_all(conn, "web_tasks", Task)
    finally:
        conn.close()


@app.post("/api/tasks")
def create_task(body: TaskCreate) -> Task:
    task = Task(
        **body.model_dump(), id=_new_id("task"), createdAt=datetime.now().astimezone()
    )
    conn = _connect()
    try:
        with conn:
            _upsert(conn, "web_tasks", task.id, task.model_dump_json())
        return task
    finally:
        conn.close()


@app.patch("/api/tasks/{task_id}")
def patch_task(task_id: str, body: TaskPatch) -> Task:
    conn = _connect()
    try:
        existing = _get(conn, "web_tasks", Task, task_id)
        if not existing:
            raise HTTPException(404, f"task {task_id} not found")
        updated = Task.model_validate(
            existing.model_dump() | body.model_dump(exclude_unset=True)
        )
        with conn:
            _upsert(conn, "web_tasks", task_id, updated.model_dump_json())
        return updated
    finally:
        conn.close()


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: str) -> None:
    conn = _connect()
    try:
        with conn:
            _delete_row(conn, "web_tasks", task_id)
            # remove the task's blocks too
            for block in _load_all(conn, "web_blocks", ScheduledBlock):
                if block.taskId == task_id:
                    _delete_row(conn, "web_blocks", block.id)
    finally:
        conn.close()


@app.get("/api/schedule/blocks")
def list_blocks(start: Optional[str] = None, end: Optional[str] = None) -> list[ScheduledBlock]:
    conn = _connect()
    try:
        blocks = _load_all(conn, "web_blocks", ScheduledBlock)
    finally:
        conn.close()
    if start:
        start_dt = datetime.fromisoformat(start)
        blocks = [b for b in blocks if b.endAt > start_dt]
    if end:
        end_dt = datetime.fromisoformat(end)
        blocks = [b for b in blocks if b.startAt < end_dt]
    return sorted(blocks, key=lambda b: b.startAt)


@app.patch("/api/schedule/blocks/{block_id}")
def patch_block(block_id: str, body: BlockPatch) -> ScheduledBlock:
    conn = _connect()
    try:
        existing = _get(conn, "web_blocks", ScheduledBlock, block_id)
        if not existing:
            raise HTTPException(404, f"block {block_id} not found")
        updated = ScheduledBlock.model_validate(
            existing.model_dump() | body.model_dump(exclude_unset=True)
        )
        if updated.startAt >= updated.endAt:
            raise HTTPException(422, "endAt must be after startAt")
        with conn:
            _upsert(conn, "web_blocks", block_id, updated.model_dump_json())
        return updated
    finally:
        conn.close()


@app.delete("/api/schedule/blocks/{block_id}", status_code=204)
def delete_block(block_id: str) -> None:
    conn = _connect()
    try:
        with conn:
            _delete_row(conn, "web_blocks", block_id)
    finally:
        conn.close()


@app.post("/api/schedule/regenerate")
def regenerate() -> ScheduleSummary:
    conn = _connect()
    try:
        return _regenerate(conn)
    finally:
        conn.close()


@app.get("/api/fixed-events")
def list_fixed_events() -> list[FixedEvent]:
    conn = _connect()
    try:
        return _load_all(conn, "web_fixed_events", FixedEvent)
    finally:
        conn.close()


@app.get("/api/availability")
def list_availability() -> list[AvailabilityWindow]:
    conn = _connect()
    try:
        windows = _load_all(conn, "web_availability", AvailabilityWindow)
        return sorted(windows, key=lambda w: (w.weekday, w.startTime))
    finally:
        conn.close()


@app.post("/api/availability")
def create_availability(body: AvailabilityCreate) -> AvailabilityWindow:
    if body.startTime >= body.endTime:
        raise HTTPException(422, "startTime must be before endTime")
    window = AvailabilityWindow(**body.model_dump(), id=_new_id("window"))
    conn = _connect()
    try:
        with conn:
            _upsert(conn, "web_availability", window.id, window.model_dump_json())
        return window
    finally:
        conn.close()


@app.patch("/api/availability/{window_id}")
def patch_availability(window_id: str, body: AvailabilityPatch) -> AvailabilityWindow:
    conn = _connect()
    try:
        existing = _get(conn, "web_availability", AvailabilityWindow, window_id)
        if not existing:
            raise HTTPException(404, f"availability window {window_id} not found")
        updated = AvailabilityWindow.model_validate(
            existing.model_dump() | body.model_dump(exclude_unset=True)
        )
        if updated.startTime >= updated.endTime:
            raise HTTPException(422, "startTime must be before endTime")
        with conn:
            _upsert(conn, "web_availability", window_id, updated.model_dump_json())
        return updated
    finally:
        conn.close()


@app.delete("/api/availability/{window_id}", status_code=204)
def delete_availability(window_id: str) -> None:
    conn = _connect()
    try:
        with conn:
            _delete_row(conn, "web_availability", window_id)
    finally:
        conn.close()


@app.get("/api/settings")
def get_settings() -> Settings:
    conn = _connect()
    try:
        return _get(conn, "web_settings", Settings, "settings") or Settings(
            dailyMaxPlannedHours=DEFAULT_MAX_PLANNED_HOURS
        )
    finally:
        conn.close()


@app.put("/api/settings")
def put_settings(body: Settings) -> Settings:
    conn = _connect()
    try:
        with conn:
            _upsert(conn, "web_settings", "settings", body.model_dump_json())
        return body
    finally:
        conn.close()


@app.post("/api/ai-import/generate-prompt")
def generate_prompt(body: RawInputBody) -> dict:
    now = datetime.now().astimezone()
    conn = _connect()
    try:
        tasks = _load_all(conn, "web_tasks", Task)
    finally:
        conn.close()
    existing = [
        {"id": t.id, "title": t.title, "deadline": t.deadline.isoformat()} for t in tasks
    ]
    schema = json.dumps(LlmOutput.model_json_schema(), indent=2, ensure_ascii=False)
    prompt = f"""You are a task-parsing assistant for a local scheduling tool.

Current time: {now.isoformat()}
Timezone: {now.tzinfo}

## Existing tasks (reuse the same id to update one)
{json.dumps(existing, indent=2, ensure_ascii=False)}

## User's raw input
{body.rawInput}

## Your job
Convert the raw input into ONE JSON object matching the schema below.
- Return ONLY a single JSON object. No prose, no multiple objects.
- Do NOT produce calendar blocks; the local tool schedules deterministically.
- Every datetime must be ISO 8601 with a UTC offset.
- estimated_hours must be a positive integer.

## JSON Schema
{schema}
"""
    return {"prompt": prompt}


def _parse_llm_output(text: str) -> LlmOutput:
    try:
        json_text = _extract_json_text(text)
    except ImportRejected as exc:
        raise HTTPException(422, detail={"errors": exc.errors})
    try:
        return LlmOutput.model_validate_json(json_text)
    except ValidationError as exc:
        errors = [
            f"{'.'.join(str(loc) for loc in err['loc']) or '<root>'}: {err['msg']}"
            for err in exc.errors()
        ]
        raise HTTPException(422, detail={"errors": errors})


@app.post("/api/ai-import/validate-output")
def validate_output(body: TextBody) -> dict:
    parsed = _parse_llm_output(body.text)
    return {"ok": True, "errors": [], "count": len(parsed.tasks)}


@app.post("/api/ai-import/import")
def import_output(body: TextBody) -> dict:
    parsed = _parse_llm_output(body.text)
    now = datetime.now().astimezone()
    conn = _connect()
    try:
        with conn:
            for item in parsed.tasks:
                task_id = item.id or _new_id("task")
                existing = _get(conn, "web_tasks", Task, task_id)
                task = Task(
                    id=task_id,
                    title=item.title,
                    type=existing.type if existing else "other",
                    deadline=item.deadline,
                    estimatedMinutes=item.estimated_hours * 60,
                    earliestStartAt=item.earliest_start_at,
                    priority=item.priority,
                    splittable=existing.splittable if existing else True,
                    status=existing.status if existing else "active",
                    createdAt=existing.createdAt if existing else now,
                )
                _upsert(conn, "web_tasks", task.id, task.model_dump_json())
    finally:
        conn.close()
    return {"imported": len(parsed.tasks)}


def main() -> None:
    import uvicorn

    uvicorn.run("planner.server:app", host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
