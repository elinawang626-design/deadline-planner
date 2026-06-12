"""FastAPI HTTP layer for the web frontend.

Speaks the frontend's JSON shapes directly (camelCase, datetimes as ISO 8601
with offsets, weekday in the JS getDay() convention: 0 = Sunday). Web entities
are stored in their own SQLite tables (web_*) inside the same database file as
the CLI, so the two workflows never corrupt each other.

Run with: planner-server  (or: python3 -m uvicorn planner.server:app)
"""
from __future__ import annotations

import sqlite3
from datetime import date, datetime
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import Field

from planner import ai_plan
from planner.ai_plan import KeptBlock, PlanChange, PlanMode, PlanRejected, WebState
from planner.engine import MAX_HORIZON_DAYS, EngineTask
from planner.engine import schedule as engine_schedule
from planner.webmodels import (
    DEFAULT_MAX_PLANNED_HOURS,
    PRIORITY_RANK,
    AvailabilityCreate,
    AvailabilityPatch,
    AvailabilityWindow,
    BlockPatch,
    FixedEvent,
    PlanCreate,
    PlanResponse,
    ScheduledBlock,
    ScheduleSummary,
    ScheduleWarning,
    Settings,
    Task,
    TaskCreate,
    TaskPatch,
    TaskScheduleStat,
    WebModel,
)


# ---- AI import request/response bodies ----


class GeneratePromptBody(WebModel):
    mode: PlanMode
    requirements: str = ""


class ValidateOutputBody(WebModel):
    text: str
    mode: PlanMode


class ImportBody(WebModel):
    text: str
    mode: PlanMode
    previewVersion: str
    acceptedChangeIds: Optional[list[str]] = None


class PlanPreviewResponse(WebModel):
    ok: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    previewVersion: str = ""
    summary: dict[str, int] = Field(default_factory=dict)
    changes: list[PlanChange] = Field(default_factory=list)
    keptBlocks: list[KeptBlock] = Field(default_factory=list)
    plan: Optional[dict] = None
    useLocalScheduler: bool = False


class ImportResponse(WebModel):
    applied: int
    rejected: int
    scheduleSummary: Optional[ScheduleSummary] = None


# ---- storage (shared helpers in planner.webdb) ----

from planner.webdb import (
    connect as _connect,
    delete_row as _delete_row,
    get_one as _get,
    load_all as _load_all,
    new_id as _new_id,
    upsert as _upsert,
)


# ---- deterministic scheduler (planner.engine; same rules as CLI and mock) ----


def _minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def _js_to_py_weekday(js_weekday: int) -> int:
    return (js_weekday + 6) % 7  # JS Sun=0 -> Python Mon=0


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and b_start < a_end


def _block_minutes(block: ScheduledBlock) -> int:
    return int((block.endAt - block.startAt).total_seconds() // 60)


def _windows_by_weekday(
    availability: list[AvailabilityWindow],
) -> dict[int, list[tuple[int, int]]]:
    windows: dict[int, list[tuple[int, int]]] = {}
    for w in availability:
        windows.setdefault(_js_to_py_weekday(w.weekday), []).append(
            (_minutes(w.startTime), _minutes(w.endTime))
        )
    return windows


def _engine_task(task: Task, planned_minutes: int) -> EngineTask:
    preferred = tuple(
        (_js_to_py_weekday(w.weekday), _minutes(w.startTime), _minutes(w.endTime))
        for w in task.preferredWindows or []
    )
    return EngineTask(
        id=task.id,
        deadline=task.deadline,
        remaining_minutes=max(0, task.estimatedMinutes - planned_minutes),
        priority_rank=PRIORITY_RANK[task.priority],
        splittable=task.splittable,
        earliest_start_at=task.earliestStartAt,
        min_block_minutes=task.minBlockMinutes,
        max_block_minutes=task.maxBlockMinutes,
        preferred_windows=preferred,
    )


def _regenerate(conn: sqlite3.Connection) -> ScheduleSummary:
    now = datetime.now().astimezone()
    tz = now.tzinfo

    tasks: list[Task] = _load_all(conn, "web_tasks", Task)
    blocks: list[ScheduledBlock] = _load_all(conn, "web_blocks", ScheduledBlock)
    availability: list[AvailabilityWindow] = _load_all(conn, "web_availability", AvailabilityWindow)
    events: list[FixedEvent] = _load_all(conn, "web_fixed_events", FixedEvent)
    settings = _get(conn, "web_settings", Settings, "settings") or Settings(
        dailyMaxPlannedHours=DEFAULT_MAX_PLANNED_HOURS
    )
    cap_minutes = settings.dailyMaxPlannedHours * 60

    removed_ids = {
        b.id
        for b in blocks
        if b.source == "local_auto" and not b.locked and not b.done and b.startAt >= now
    }
    kept = [b for b in blocks if b.id not in removed_ids]

    # Fixed events and every kept block occupy time; only future, not-done
    # task blocks count toward the daily load cap.
    busy = [(e.startAt, e.endAt) for e in events] + [(b.startAt, b.endAt) for b in kept]
    day_load: dict[date, int] = {}
    for b in kept:
        if b.done or b.startAt < now:
            continue
        key = b.startAt.astimezone(tz).date()
        day_load[key] = day_load.get(key, 0) + _block_minutes(b)

    planned_by_task: dict[str, int] = {}
    for b in kept:
        planned_by_task[b.taskId] = planned_by_task.get(b.taskId, 0) + _block_minutes(b)

    active = [t for t in tasks if t.status == "active"]
    titles = {t.id: t.title for t in tasks}
    engine_tasks = [_engine_task(t, planned_by_task.get(t.id, 0)) for t in active]

    result = engine_schedule(
        now=now,
        tz=tz,
        tasks=engine_tasks,
        windows_by_weekday=_windows_by_weekday(availability),
        busy=busy,
        initial_day_load=day_load,
        daily_max_minutes=cap_minutes,
    )

    warnings: list[ScheduleWarning] = []
    unscheduled: list[str] = []
    overloaded_days: set[date] = set()
    for w in result.warnings:
        title = titles.get(w.task_id, w.task_id)
        if w.kind == "beyond_horizon":
            warnings.append(
                ScheduleWarning(
                    type="deadline_unreachable",
                    taskId=w.task_id,
                    message=f"任务「{title}」截止日超出 {MAX_HORIZON_DAYS} 天调度范围，仅安排范围内时段",
                )
            )
        elif w.kind == "partial":
            warnings.append(
                ScheduleWarning(
                    type="insufficient_time",
                    taskId=w.task_id,
                    message=(
                        f"任务「{title}」只安排了 {w.placed_minutes}/{w.requested_minutes} 分钟，"
                        "截止前即使超载也没有更多可用时间"
                    ),
                )
            )
        elif w.kind == "no_slot":
            unscheduled.append(w.task_id)
            warnings.append(
                ScheduleWarning(
                    type="deadline_unreachable",
                    taskId=w.task_id,
                    message=f"任务「{title}」在截止前没有可用空档",
                )
            )
        elif w.kind == "non_splittable":
            unscheduled.append(w.task_id)
            warnings.append(
                ScheduleWarning(
                    type="insufficient_time",
                    taskId=w.task_id,
                    message=(
                        f"任务「{title}」不可拆分，且截止前找不到足够长的连续空档"
                    ),
                )
            )
        elif w.kind == "overload" and w.day is not None:
            overloaded_days.add(w.day)
            warnings.append(
                ScheduleWarning(
                    type="overloaded_day",
                    taskId=w.task_id,
                    message=(
                        f"为按期完成「{title}」，{w.day.isoformat()} 在每日上限 "
                        f"{settings.dailyMaxPlannedHours} 小时之外额外安排 {w.extra_minutes} 分钟"
                    ),
                )
            )

    created = [
        ScheduledBlock(
            id=f"auto-{b.task_id}-{b.start_at.strftime('%Y%m%dT%H%M%z')}",
            taskId=b.task_id,
            startAt=b.start_at,
            endAt=b.end_at,
            locked=False,
            source="local_auto",
            done=False,
        )
        for b in result.blocks
    ]
    all_blocks = kept + created

    # Days overloaded purely by manual/locked blocks (the engine never plans
    # past the cap on its own outside the warned overload days).
    minutes_by_day: dict[date, int] = {}
    for block in all_blocks:
        if block.done:
            continue
        key = block.startAt.astimezone(tz).date()
        minutes_by_day[key] = minutes_by_day.get(key, 0) + _block_minutes(block)
    for day_key in sorted(minutes_by_day):
        minutes = minutes_by_day[day_key]
        if minutes > cap_minutes and day_key not in overloaded_days:
            warnings.append(
                ScheduleWarning(
                    type="overloaded_day",
                    message=(
                        f"{day_key.isoformat()} 计划 {minutes / 60:.1f} 小时，"
                        f"超过每日上限 {settings.dailyMaxPlannedHours} 小时"
                    ),
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

    placed_by_task = {s.task_id: s for s in result.stats}
    task_stats: list[TaskScheduleStat] = []
    total_unscheduled = 0
    for task in active:
        planned = planned_by_task.get(task.id, 0)
        stat = placed_by_task.get(task.id)
        placed = stat.placed_minutes if stat else 0
        remaining = (
            stat.remaining_minutes
            if stat
            else max(0, task.estimatedMinutes - planned)
        )
        total_unscheduled += remaining
        task_stats.append(
            TaskScheduleStat(
                taskId=task.id,
                scheduledMinutes=planned + placed,
                unscheduledMinutes=remaining,
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
        totalUnscheduledMinutes=total_unscheduled,
        taskStats=task_stats,
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

from planner.track_api import purge_task_data, router as track_router  # noqa: E402

app.include_router(track_router)


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
            # checklist/work logs/attachments/estimates/career card + copied files
            purge_task_data(conn, task_id)
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
        patch = body.model_dump(exclude_unset=True)
        # a user-moved/resized AI or auto block becomes a manual block
        time_changed = ("startAt" in patch and patch["startAt"] != existing.startAt) or (
            "endAt" in patch and patch["endAt"] != existing.endAt
        )
        if time_changed and "source" not in patch:
            patch["source"] = "manual"
        updated = ScheduledBlock.model_validate(existing.model_dump() | patch)
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


def _manual_plan_warnings(
    conn: sqlite3.Connection, task: Task, block: ScheduledBlock
) -> list[ScheduleWarning]:
    """Manual plans are always saved; these warnings explain what they violate."""
    tz = datetime.now().astimezone().tzinfo
    warnings: list[ScheduleWarning] = []
    events = _load_all(conn, "web_fixed_events", FixedEvent)
    others = [
        b for b in _load_all(conn, "web_blocks", ScheduledBlock) if b.id != block.id
    ]
    availability = _load_all(conn, "web_availability", AvailabilityWindow)
    settings = _get(conn, "web_settings", Settings, "settings") or Settings(
        dailyMaxPlannedHours=DEFAULT_MAX_PLANNED_HOURS
    )

    for event in events:
        if _overlaps(block.startAt, block.endAt, event.startAt, event.endAt):
            warnings.append(
                ScheduleWarning(
                    type="overlap",
                    taskId=task.id,
                    message=f"手动计划与固定事件「{event.title}」重叠",
                )
            )
    for other in others:
        if _overlaps(block.startAt, block.endAt, other.startAt, other.endAt):
            warnings.append(
                ScheduleWarning(
                    type="overlap",
                    taskId=task.id,
                    message=(
                        "手动计划与已有时间块重叠："
                        f"{other.startAt.astimezone(tz):%m-%d %H:%M}–"
                        f"{other.endAt.astimezone(tz):%H:%M}"
                    ),
                )
            )

    local_start = block.startAt.astimezone(tz)
    local_end = block.endAt.astimezone(tz)
    start_min = local_start.hour * 60 + local_start.minute
    end_min = (
        local_end.hour * 60 + local_end.minute
        if local_end.date() == local_start.date()
        else 24 * 60
    )
    if availability:
        day_windows = [
            (_minutes(w.startTime), _minutes(w.endTime))
            for w in availability
            if _js_to_py_weekday(w.weekday) == local_start.weekday()
        ]
    else:
        day_windows = [(9 * 60, 17 * 60)]
    if not any(ws <= start_min and end_min <= we for ws, we in day_windows):
        warnings.append(
            ScheduleWarning(
                type="outside_availability",
                taskId=task.id,
                message="手动计划超出当天的可用时间窗口",
            )
        )

    if block.endAt > task.deadline:
        warnings.append(
            ScheduleWarning(
                type="past_deadline",
                taskId=task.id,
                message=f"手动计划晚于任务「{task.title}」的截止时间",
            )
        )

    day_minutes = sum(
        _block_minutes(b)
        for b in others
        if not b.done and b.startAt.astimezone(tz).date() == local_start.date()
    ) + _block_minutes(block)
    cap_minutes = settings.dailyMaxPlannedHours * 60
    if day_minutes > cap_minutes:
        warnings.append(
            ScheduleWarning(
                type="overloaded_day",
                taskId=task.id,
                message=(
                    f"{local_start.date().isoformat()} 计划 {day_minutes / 60:.1f} 小时，"
                    f"超过每日上限 {settings.dailyMaxPlannedHours} 小时"
                ),
            )
        )
    return warnings


@app.post("/api/plans")
def create_plan(body: PlanCreate) -> PlanResponse:
    if body.startAt >= body.endAt:
        raise HTTPException(422, "endAt must be after startAt")
    if (body.taskId is None) == (body.newTask is None):
        raise HTTPException(422, "provide exactly one of taskId or newTask")
    now = datetime.now().astimezone()
    conn = _connect()
    try:
        with conn:  # atomic: optional new task + its manual block
            if body.taskId:
                task = _get(conn, "web_tasks", Task, body.taskId)
                if not task:
                    raise HTTPException(404, f"task {body.taskId} not found")
            else:
                task = Task(
                    **body.newTask.model_dump(), id=_new_id("task"), createdAt=now
                )
                _upsert(conn, "web_tasks", task.id, task.model_dump_json())
            block = ScheduledBlock(
                id=_new_id("block"),
                taskId=task.id,
                startAt=body.startAt,
                endAt=body.endAt,
                locked=True,
                source="manual",
                done=False,
                notes=body.notes,
            )
            _upsert(conn, "web_blocks", block.id, block.model_dump_json())
        warnings = _manual_plan_warnings(conn, task, block)
        summary = _regenerate(conn)
        return PlanResponse(task=task, block=block, warnings=warnings, summary=summary)
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


def _load_state(conn: sqlite3.Connection) -> WebState:
    return WebState(
        tasks=_load_all(conn, "web_tasks", Task),
        blocks=_load_all(conn, "web_blocks", ScheduledBlock),
        availability=_load_all(conn, "web_availability", AvailabilityWindow),
        events=_load_all(conn, "web_fixed_events", FixedEvent),
        settings=_get(conn, "web_settings", Settings, "settings")
        or Settings(dailyMaxPlannedHours=DEFAULT_MAX_PLANNED_HOURS),
    )


def _extract_or_422(text: str) -> ai_plan.AiPlan:
    try:
        return ai_plan.extract_plan(text)
    except PlanRejected as exc:
        raise HTTPException(422, detail={"errors": exc.errors})


@app.post("/api/ai-import/generate-prompt")
def generate_prompt(body: GeneratePromptBody) -> dict:
    now = datetime.now().astimezone()
    conn = _connect()
    try:
        state = _load_state(conn)
    finally:
        conn.close()
    return {"prompt": ai_plan.build_plan_prompt(body.mode, body.requirements, state, now)}


@app.post("/api/ai-import/validate-output")
def validate_output(body: ValidateOutputBody) -> PlanPreviewResponse:
    plan = _extract_or_422(body.text)
    now = datetime.now().astimezone()
    conn = _connect()
    try:
        state = _load_state(conn)
    finally:
        conn.close()
    scenario = ai_plan.build_scenario(state, plan, body.mode, now)
    return PlanPreviewResponse(
        ok=not scenario.errors,
        errors=scenario.errors,
        warnings=scenario.warnings,
        previewVersion=ai_plan.state_version(state),
        summary=ai_plan.change_summary(scenario),
        changes=scenario.changes,
        keptBlocks=scenario.kept_blocks,
        plan=plan.model_dump(mode="json", exclude_unset=True),
        useLocalScheduler=scenario.use_local_scheduler,
    )


@app.post("/api/ai-import/import")
def import_output(body: ImportBody) -> ImportResponse:
    """Re-validate against fresh data, then apply the accepted changes atomically."""
    plan = _extract_or_422(body.text)
    now = datetime.now().astimezone()
    conn = _connect()
    try:
        state = _load_state(conn)
        if ai_plan.state_version(state) != body.previewVersion:
            raise HTTPException(
                409, detail={"errors": ["数据在预览后已发生变化，请重新校验并查看新预览"]}
            )
        accepted = (
            None if body.acceptedChangeIds is None else set(body.acceptedChangeIds)
        )
        scenario = ai_plan.build_scenario(state, plan, body.mode, now, accepted=accepted)
        if scenario.errors:
            raise HTTPException(422, detail={"errors": scenario.errors})

        # diff initial vs accepted-final state; write everything in one transaction
        tables: list[tuple[str, dict, dict]] = [
            ("web_tasks", {t.id: t for t in state.tasks}, scenario.final_tasks),
            ("web_blocks", {b.id: b for b in state.blocks}, scenario.final_blocks),
            (
                "web_availability",
                {w.id: w for w in state.availability},
                scenario.final_availability,
            ),
            ("web_fixed_events", {e.id: e for e in state.events}, scenario.final_events),
        ]
        with conn:
            for table, initial, final in tables:
                for entity_id in set(initial) - set(final):
                    _delete_row(conn, table, entity_id)
                for entity_id, entity in final.items():
                    if initial.get(entity_id) != entity:
                        _upsert(conn, table, entity_id, entity.model_dump_json())
        summary = _regenerate(conn) if scenario.use_local_scheduler else None
        return ImportResponse(
            applied=len(scenario.effective_ids),
            rejected=len(scenario.changes) - len(scenario.effective_ids),
            scheduleSummary=summary,
        )
    finally:
        conn.close()


def main() -> None:
    import uvicorn

    uvicorn.run("planner.server:app", host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
