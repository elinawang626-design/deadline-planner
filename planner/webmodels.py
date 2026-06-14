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

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from planner.models import _require_tz

DEFAULT_MAX_PLANNED_HOURS = 6
PRIORITY_RANK = {"urgent": 0, "high": 1, "medium": 2, "low": 3}

Priority = Literal["low", "medium", "high", "urgent"]
TaskType = Literal[
    "assignment", "exam", "project", "admin", "personal", "research", "coding", "other"
]
TaskStatus = Literal["active", "completed", "archived"]
BlockSource = Literal["ai", "local_auto", "manual"]

Language = Literal["zh-CN", "en-US"]
AiMode = Literal["manual", "api"]
ProviderName = Literal["openai", "deepseek", "claude"]

# Preset API base URLs; model names are user-editable so a new model version
# never requires a code change. Defaults are sensible starting points only.
DEFAULT_PROVIDER_CONFIGS: dict[str, dict[str, str]] = {
    "openai": {"baseUrl": "https://api.openai.com/v1", "model": "gpt-4o"},
    "deepseek": {"baseUrl": "https://api.deepseek.com", "model": "deepseek-chat"},
    "claude": {"baseUrl": "https://api.anthropic.com", "model": "claude-3-5-sonnet-latest"},
}


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
    # No deadline means the task is excluded from auto-scheduling.
    deadline: Optional[datetime] = None
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
    deadline: Optional[datetime] = None
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


class ProviderConfig(WebModel):
    baseUrl: str
    model: str = ""


def _default_providers() -> dict[str, ProviderConfig]:
    return {
        name: ProviderConfig(**cfg) for name, cfg in DEFAULT_PROVIDER_CONFIGS.items()
    }


class Settings(WebModel):
    dailyMaxPlannedHours: int = Field(gt=0, le=24)
    language: Language = "zh-CN"
    aiMode: AiMode = "manual"
    activeProvider: ProviderName = "openai"
    providers: dict[str, ProviderConfig] = Field(default_factory=_default_providers)

    @model_validator(mode="after")
    def _ensure_all_providers(self) -> "Settings":
        # Old settings (and partial PUTs) get every provider filled with its
        # preset defaults so the rest of the code can assume all three exist.
        merged = _default_providers()
        merged.update(self.providers)
        self.providers = merged
        return self


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
