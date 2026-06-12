"""Deterministic schedule generation for the CLI (adapter over the engine).

Rules (shared with the web server and the frontend mock via planner.engine):
- Scheduling range: from now to the latest task deadline, at most 90 days.
- 15-minute slot granularity; contiguous chunks of about one hour.
- Default availability 09:00-17:00 local time when no rules are configured.
- Future, unlocked, auto-generated blocks are replaced; past blocks, locked
  blocks and manual blocks are kept and treated as busy.
- Tasks are ordered by deadline, then remaining capacity before the
  deadline, then priority, then id; work is balanced across the days before
  each deadline with a mild preference for earlier days.
- Preferred windows are a scoring bonus; falling short on preference never
  blocks scheduling.

The CLI has no daily planned-hours cap, so the overload phase never runs
here; the web server passes its configured cap to the same engine.
"""
from __future__ import annotations

from datetime import date, datetime, time, tzinfo
from typing import Sequence

from planner.engine import EngineTask, schedule
from planner.models import (
    PRIORITY_RANK,
    WEEKDAY_INDEX,
    AvailabilityRule,
    FixedEvent,
    ParsedTask,
    ScheduleResult,
    ScheduledBlock,
)


def _minutes_of_day(value: time) -> int:
    return value.hour * 60 + value.minute


def _windows_by_weekday(
    rules: Sequence[AvailabilityRule],
) -> dict[int, list[tuple[int, int]]]:
    windows: dict[int, list[tuple[int, int]]] = {}
    for rule in rules:
        for weekday in rule.weekdays:
            windows.setdefault(WEEKDAY_INDEX[weekday], []).append(
                (_minutes_of_day(rule.start_time), _minutes_of_day(rule.end_time))
            )
    return windows


def _engine_task(task: ParsedTask, planned_minutes: int) -> EngineTask:
    preferred = tuple(
        (WEEKDAY_INDEX[weekday], _minutes_of_day(w.start_time), _minutes_of_day(w.end_time))
        for w in task.preferred_windows
        for weekday in w.weekdays
    )
    return EngineTask(
        id=task.id,
        deadline=task.deadline,
        remaining_minutes=max(0, task.estimated_hours * 60 - planned_minutes),
        priority_rank=PRIORITY_RANK[task.priority],
        splittable=True,
        earliest_start_at=task.earliest_start_at,
        preferred_windows=preferred,
    )


def generate_schedule(
    now: datetime,
    tz: tzinfo,
    tasks: Sequence[ParsedTask],
    rules: Sequence[AvailabilityRule],
    fixed_events: Sequence[FixedEvent],
    existing_blocks: Sequence[ScheduledBlock],
) -> tuple[ScheduleResult, list[str]]:
    """Compute a new schedule.

    Returns (result, ids of existing blocks to delete). Persistence is the
    caller's responsibility.
    """
    now_local = now.astimezone(tz)

    delete_ids = [
        b.id
        for b in existing_blocks
        if b.auto_generated and not b.locked and b.start_at >= now_local
    ]
    deleted = set(delete_ids)
    kept_blocks = [b for b in existing_blocks if b.id not in deleted]

    busy = [(e.start_at, e.end_at) for e in fixed_events] + [
        (b.start_at, b.end_at) for b in kept_blocks
    ]
    day_load: dict[date, int] = {}
    planned_by_task: dict[str, int] = {}
    for block in kept_blocks:
        if block.start_at < now_local:
            continue
        minutes = int((block.end_at - block.start_at).total_seconds() // 60)
        key = block.start_at.astimezone(tz).date()
        day_load[key] = day_load.get(key, 0) + minutes
        planned_by_task[block.task_id] = planned_by_task.get(block.task_id, 0) + minutes

    engine_tasks = [_engine_task(t, planned_by_task.get(t.id, 0)) for t in tasks]

    result = schedule(
        now=now_local,
        tz=tz,
        tasks=engine_tasks,
        windows_by_weekday=_windows_by_weekday(rules),
        busy=busy,
        initial_day_load=day_load,
        daily_max_minutes=None,
    )

    warnings: list[str] = []
    unscheduled: list[str] = []
    for warning in result.warnings:
        if warning.kind == "beyond_horizon":
            warnings.append(
                f"task {warning.task_id!r}: deadline is beyond the 90-day "
                "scheduling window; only slots inside the window are used"
            )
        elif warning.kind == "partial":
            warnings.append(
                f"task {warning.task_id!r} only partially scheduled: "
                f"{warning.placed_minutes} of {warning.requested_minutes} "
                "minute(s) placed before its deadline"
            )
        elif warning.kind in ("no_slot", "non_splittable"):
            unscheduled.append(warning.task_id)
            warnings.append(
                f"task {warning.task_id!r} could not be scheduled: no eligible "
                "free slots before its deadline within the scheduling window"
            )

    new_blocks = [
        ScheduledBlock(
            id=f"auto-{b.task_id}-{b.start_at.strftime('%Y%m%dT%H%M%z')}",
            task_id=b.task_id,
            start_at=b.start_at,
            end_at=b.end_at,
            locked=False,
            auto_generated=True,
        )
        for b in result.blocks
    ]
    return (
        ScheduleResult(
            blocks=new_blocks, unscheduled_task_ids=unscheduled, warnings=warnings
        ),
        delete_ids,
    )
