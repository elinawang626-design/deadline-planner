"""Deterministic schedule generation.

Rules implemented here:
- Scheduling range: from now (rounded up to the next full hour) to now + 14 days.
- Default availability 09:00-17:00 local time when no rules are configured.
- Future, unlocked, auto-generated blocks inside the range are replaced;
  past blocks, locked blocks and non-auto blocks are kept and treated as busy.
- Available time is cut into one-hour slots; slots overlapping fixed events
  or any kept block are excluded.
- Tasks are ordered by deadline asc, priority desc, id asc.
- A task may be split into one-hour blocks across days, using only slots not
  earlier than earliest_start_at and ending no later than its deadline.
- Preferred windows are tried first; falling short on preference never blocks
  scheduling.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, tzinfo
from typing import Sequence

from planner.models import (
    PRIORITY_RANK,
    WEEKDAY_INDEX,
    AvailabilityRule,
    FixedEvent,
    ParsedTask,
    PreferredWindow,
    ScheduleResult,
    ScheduledBlock,
)

HORIZON_DAYS = 14
DEFAULT_AVAILABILITY_START = time(9, 0)
DEFAULT_AVAILABILITY_END = time(17, 0)


def ceil_to_hour(dt: datetime) -> datetime:
    if dt.minute or dt.second or dt.microsecond:
        return dt.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return dt


def _minutes(t: time) -> int:
    return t.hour * 60 + t.minute


def _windows_for_day(
    rules: Sequence[AvailabilityRule], day: date
) -> list[tuple[time, time]]:
    if not rules:
        return [(DEFAULT_AVAILABILITY_START, DEFAULT_AVAILABILITY_END)]
    weekday = day.weekday()
    return [
        (r.start_time, r.end_time)
        for r in rules
        if any(WEEKDAY_INDEX[w] == weekday for w in r.weekdays)
    ]


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and b_start < a_end


def _build_free_slots(
    horizon_start: datetime,
    horizon_end: datetime,
    tz: tzinfo,
    rules: Sequence[AvailabilityRule],
    busy: Sequence[tuple[datetime, datetime]],
) -> list[datetime]:
    """Return sorted, deduplicated one-hour slot start times."""
    starts: set[datetime] = set()
    day = horizon_start.date()
    last_day = horizon_end.date()
    while day <= last_day:
        for window_start, window_end in _windows_for_day(rules, day):
            first_hour = window_start.hour + (1 if _minutes(window_start) % 60 else 0)
            for hour in range(first_hour, 24):
                if (hour + 1) * 60 > _minutes(window_end):
                    break
                slot_start = datetime(day.year, day.month, day.day, hour, tzinfo=tz)
                slot_end = slot_start + timedelta(hours=1)
                if slot_start < horizon_start or slot_end > horizon_end:
                    continue
                if any(_overlaps(slot_start, slot_end, bs, be) for bs, be in busy):
                    continue
                starts.add(slot_start)
        day += timedelta(days=1)
    return sorted(starts)


def _in_preferred_window(slot_start: datetime, windows: Sequence[PreferredWindow]) -> bool:
    slot_end_min = _minutes(slot_start.time()) + 60
    for window in windows:
        if slot_start.weekday() not in (WEEKDAY_INDEX[w] for w in window.weekdays):
            continue
        if slot_start.time() >= window.start_time and slot_end_min <= _minutes(window.end_time):
            return True
    return False


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
    horizon_start = ceil_to_hour(now_local)
    horizon_end = now_local + timedelta(days=HORIZON_DAYS)

    delete_ids = [
        b.id
        for b in existing_blocks
        if b.auto_generated and not b.locked and now_local <= b.start_at < horizon_end
    ]
    deleted = set(delete_ids)
    kept_blocks = [b for b in existing_blocks if b.id not in deleted]

    busy = [(e.start_at, e.end_at) for e in fixed_events] + [
        (b.start_at, b.end_at) for b in kept_blocks
    ]
    free = _build_free_slots(horizon_start, horizon_end, tz, rules, busy)

    ordered = sorted(
        tasks, key=lambda t: (t.deadline, PRIORITY_RANK[t.priority], t.id)
    )

    used: set[datetime] = set()
    new_blocks: list[ScheduledBlock] = []
    warnings: list[str] = []
    unscheduled: list[str] = []

    for task in ordered:
        if task.deadline > horizon_end:
            warnings.append(
                f"task {task.id!r}: deadline {task.deadline.isoformat()} is beyond "
                f"the {HORIZON_DAYS}-day scheduling window; only slots inside the "
                "window are used"
            )

        eligible = [
            s
            for s in free
            if s not in used
            and (task.earliest_start_at is None or s >= task.earliest_start_at)
            and s + timedelta(hours=1) <= task.deadline
        ]
        preferred = [s for s in eligible if _in_preferred_window(s, task.preferred_windows)]
        rest = [s for s in eligible if not _in_preferred_window(s, task.preferred_windows)]
        picks = (preferred + rest)[: task.estimated_hours]

        if not picks:
            unscheduled.append(task.id)
            warnings.append(
                f"task {task.id!r} could not be scheduled: no eligible free slots "
                "before its deadline within the scheduling window"
            )
            continue
        if len(picks) < task.estimated_hours:
            warnings.append(
                f"task {task.id!r} only partially scheduled: {len(picks)} of "
                f"{task.estimated_hours} hour(s) placed before its deadline"
            )

        for slot_start in picks:
            used.add(slot_start)
            new_blocks.append(
                ScheduledBlock(
                    id=f"auto-{task.id}-{slot_start.strftime('%Y%m%dT%H%M%z')}",
                    task_id=task.id,
                    start_at=slot_start,
                    end_at=slot_start + timedelta(hours=1),
                    locked=False,
                    auto_generated=True,
                )
            )

    new_blocks.sort(key=lambda b: (b.start_at, b.task_id))
    result = ScheduleResult(
        blocks=new_blocks, unscheduled_task_ids=unscheduled, warnings=warnings
    )
    return result, delete_ids
