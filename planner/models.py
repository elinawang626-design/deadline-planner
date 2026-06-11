"""Pydantic models for the planner. All models reject unknown fields."""
from __future__ import annotations

from datetime import datetime, time
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
Priority = Literal["high", "medium", "low"]

WEEKDAY_INDEX: dict[str, int] = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}
PRIORITY_RANK: dict[str, int] = {"high": 0, "medium": 1, "low": 2}


def _require_tz(value: datetime) -> datetime:
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise ValueError("datetime must be timezone-aware (ISO 8601 with UTC offset)")
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _LocalWindow(StrictModel):
    """A weekday-based window expressed in local wall-clock time."""

    weekdays: list[Weekday] = Field(min_length=1)
    start_time: time
    end_time: time

    @model_validator(mode="after")
    def _check_order(self) -> "_LocalWindow":
        if self.start_time >= self.end_time:
            raise ValueError(
                "start_time must be before end_time (windows must not cross midnight; "
                "split a cross-midnight window into two rules)"
            )
        return self


class PreferredWindow(_LocalWindow):
    pass


class AvailabilityRule(_LocalWindow):
    id: str = Field(min_length=1)


class ParsedTask(StrictModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    deadline: datetime
    estimated_hours: int = Field(gt=0)
    priority: Priority
    earliest_start_at: Optional[datetime] = None
    preferred_windows: list[PreferredWindow] = Field(default_factory=list)

    _tz_deadline = field_validator("deadline")(_require_tz)

    @field_validator("earliest_start_at")
    @classmethod
    def _tz_earliest(cls, value: Optional[datetime]) -> Optional[datetime]:
        if value is None:
            return None
        return _require_tz(value)


class FixedEvent(StrictModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    start_at: datetime
    end_at: datetime

    _tz_start = field_validator("start_at")(_require_tz)
    _tz_end = field_validator("end_at")(_require_tz)

    @model_validator(mode="after")
    def _check_order(self) -> "FixedEvent":
        if self.start_at >= self.end_at:
            raise ValueError("start_at must be before end_at")
        return self


class ParsedInput(StrictModel):
    tasks: list[ParsedTask] = Field(default_factory=list)
    availability_rules: list[AvailabilityRule] = Field(default_factory=list)
    fixed_events: list[FixedEvent] = Field(default_factory=list)


class ScheduledBlock(StrictModel):
    id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    start_at: datetime
    end_at: datetime
    locked: bool = False
    auto_generated: bool = True

    _tz_start = field_validator("start_at")(_require_tz)
    _tz_end = field_validator("end_at")(_require_tz)

    @model_validator(mode="after")
    def _check_order(self) -> "ScheduledBlock":
        if self.start_at >= self.end_at:
            raise ValueError("start_at must be before end_at")
        return self


class ScheduleResult(StrictModel):
    blocks: list[ScheduledBlock] = Field(default_factory=list)
    unscheduled_task_ids: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
