from __future__ import annotations

from datetime import datetime, timezone

from planner.models import ParsedTask

UTC = timezone.utc


def dt(*args) -> datetime:
    return datetime(*args, tzinfo=UTC)


def make_task(
    task_id: str = "t1",
    title: str | None = None,
    deadline: datetime | None = None,
    hours: int = 1,
    priority: str = "medium",
    **extra,
) -> ParsedTask:
    return ParsedTask(
        id=task_id,
        title=title or f"Task {task_id}",
        deadline=deadline or dt(2026, 6, 24, 17, 0),
        estimated_hours=hours,
        priority=priority,
        **extra,
    )
