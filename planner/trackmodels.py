"""Pydantic models for task tracking: checklist items, work logs, attachments,
AI estimates and career cards (camelCase, same conventions as planner.webmodels).

Stored in their own web_task_* SQLite JSON tables; every record carries a
``taskId`` referencing web_tasks.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import Field, field_validator

from planner.models import _require_tz
from planner.webmodels import WebModel

StorageMode = Literal["copy", "link"]
ExtractionStatus = Literal["ok", "failed", "unsupported"]
Confidence = Literal["low", "medium", "high"]


# ---- checklist ----


class ChecklistItem(WebModel):
    id: str
    taskId: str
    title: str = Field(min_length=1)
    completed: bool = False
    position: int = 0
    createdAt: datetime

    _tz = field_validator("createdAt")(classmethod(lambda cls, v: _require_tz(v)))


class ChecklistItemCreate(WebModel):
    title: str = Field(min_length=1)
    position: Optional[int] = None  # default: append to the end


class ChecklistItemPatch(WebModel):
    title: Optional[str] = Field(default=None, min_length=1)
    completed: Optional[bool] = None
    position: Optional[int] = None


# ---- work logs ----


class WorkLog(WebModel):
    id: str
    taskId: str
    workedAt: date
    durationMinutes: int = Field(gt=0)
    summary: str = Field(min_length=1)
    challenge: Optional[str] = None
    result: Optional[str] = None
    createdAt: datetime

    _tz = field_validator("createdAt")(classmethod(lambda cls, v: _require_tz(v)))


class WorkLogCreate(WebModel):
    workedAt: date
    durationMinutes: int = Field(gt=0)
    summary: str = Field(min_length=1)
    challenge: Optional[str] = None
    result: Optional[str] = None


class WorkLogPatch(WebModel):
    workedAt: Optional[date] = None
    durationMinutes: Optional[int] = Field(default=None, gt=0)
    summary: Optional[str] = Field(default=None, min_length=1)
    challenge: Optional[str] = None
    result: Optional[str] = None


# ---- attachments ----


class Attachment(WebModel):
    id: str
    taskId: str
    displayName: str
    storageMode: StorageMode
    originalPath: Optional[str] = None  # link mode: absolute source path
    storedPath: Optional[str] = None  # copy mode: path relative to files root
    mimeType: Optional[str] = None
    sizeBytes: int = 0
    description: Optional[str] = None
    extractionStatus: ExtractionStatus = "unsupported"
    extractedText: Optional[str] = None
    createdAt: datetime

    _tz = field_validator("createdAt")(classmethod(lambda cls, v: _require_tz(v)))


class AttachmentLinkCreate(WebModel):
    """Link mode: record an absolute path without copying the file."""

    path: str = Field(min_length=1)
    description: Optional[str] = None


# ---- AI estimates ----


class EstimateStep(WebModel):
    step: str = Field(min_length=1)
    minutes: int = Field(gt=0)


class Estimate(WebModel):
    id: str
    taskId: str
    optimisticMinutes: int = Field(gt=0)
    likelyMinutes: int = Field(gt=0)
    pessimisticMinutes: int = Field(gt=0)
    confidence: Confidence
    breakdown: list[EstimateStep] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    sourceAttachmentIds: list[str] = Field(default_factory=list)
    createdAt: datetime
    appliedAt: Optional[datetime] = None

    _tz = field_validator("createdAt", "appliedAt")(
        classmethod(lambda cls, v: None if v is None else _require_tz(v))
    )


# ---- career cards (one per task) ----


class CareerCard(WebModel):
    id: str
    taskId: str
    context: str
    role: str
    actions: list[str] = Field(default_factory=list)
    challenges: list[str] = Field(default_factory=list)
    outcomes: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    evidenceAttachmentIds: list[str] = Field(default_factory=list)
    createdAt: datetime
    updatedAt: datetime

    _tz = field_validator("createdAt", "updatedAt")(
        classmethod(lambda cls, v: _require_tz(v))
    )


class CareerCardPatch(WebModel):
    context: Optional[str] = None
    role: Optional[str] = None
    actions: Optional[list[str]] = None
    challenges: Optional[list[str]] = None
    outcomes: Optional[list[str]] = None
    metrics: Optional[list[str]] = None
    skills: Optional[list[str]] = None


# ---- aggregated list-page summary ----


class TrackingSummary(WebModel):
    taskId: str
    checklistDone: int = 0
    checklistTotal: int = 0
    actualMinutes: int = 0
    attachmentCount: int = 0
