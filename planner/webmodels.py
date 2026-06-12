"""Pydantic models for the web API (camelCase, JS weekday convention 0=Sunday).

Shared by the FastAPI layer (planner.server) and the AI plan import module
(planner.ai_plan). Block ``source`` distinguishes who placed a block:

- ``ai``: an external AI placed it via the AI import workflow.
- ``local_auto``: the local deterministic scheduler placed it.
- ``manual``: the user placed it (or edited an AI/auto block, which converts
  it to manual).

The legacy stored value ``auto`` is read as ``local_auto``.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from planner.models import _require_tz

DEFAULT_MAX_PLANNED_HOURS = 6
PRIORITY_RANK = {"urgent": 0, "high": 1, "medium": 2, "low": 3}

Priority = Literal["low", "medium", "high", "urgent"]
TaskType = Literal[
    "assignment", "exam", "project", "admin", "personal", "research", "coding", "other"
]
TaskStatus = Literal["active", "completed", "archived"]
BlockSource = Literal["ai", "local_auto", "manual"]


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
    source: BlockSource = "local_auto"
    done: bool = False
    notes: Optional[str] = None

    _tz = field_validator("startAt", "endAt")(classmethod(lambda cls, v: _require_tz(v)))

    @field_validator("source", mode="before")
    @classmethod
    def _migrate_legacy_source(cls, value: object) -> object:
        return "local_auto" if value == "auto" else value


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


class TaskScheduleStat(WebModel):
    taskId: str
    scheduledMinutes: int
    unscheduledMinutes: int


class ScheduleSummary(WebModel):
    createdBlocks: int
    removedBlocks: int
    unscheduledTaskIds: list[str]
    totalUnscheduledMinutes: int = 0
    taskStats: list[TaskScheduleStat] = Field(default_factory=list)
    warnings: list[ScheduleWarning] = Field(default_factory=list)


class PlanCreate(WebModel):
    """One atomic manual plan: bind an existing task or create a new one."""

    taskId: Optional[str] = None
    newTask: Optional[TaskCreate] = None
    startAt: datetime
    endAt: datetime
    notes: Optional[str] = None

    _tz = field_validator("startAt", "endAt")(classmethod(lambda cls, v: _require_tz(v)))


class PlanResponse(WebModel):
    task: Task
    block: ScheduledBlock
    warnings: list[ScheduleWarning]
    summary: ScheduleSummary
