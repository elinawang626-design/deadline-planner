"""AI-led plan import: prompt building, lenient JSON extraction, structured
preview and scenario validation.

Workflow (no LLM API involved):
1. ``build_plan_prompt`` renders the full context (tasks, availability, fixed
   events, future blocks, daily cap, mode rules, JSON schema) for the user to
   paste into any external AI.
2. ``extract_plan`` finds exactly one valid plan JSON inside the pasted reply
   (pure JSON, fenced block, or JSON surrounded by prose).
3. ``build_scenario`` turns the plan into per-record changes with field-level
   diffs, computes the final state for a chosen subset of changes, and
   validates every AI block placement. No persistence here.
4. The server applies an accepted scenario inside a single transaction.

Modes:
- ``ai_plan``:     AI builds a fresh plan; future, unlocked, not-done machine
                   blocks (``ai`` + ``local_auto``) are replaced.
- ``ai_optimize``: AI re-plans only future, unlocked, not-done ``ai`` blocks;
                   everything else is a hard constraint.
- ``tasks_only``:  AI may only change tasks/availability/fixed events; the
                   local deterministic scheduler re-plans afterwards.

Protected blocks (past, done, manual, locked) are never moved or removed.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import Field, ValidationError, field_validator, model_validator

from planner.models import _require_tz
from planner.webmodels import (
    AvailabilityWindow,
    FixedEvent,
    Priority,
    ScheduledBlock,
    Settings,
    Task,
    TaskType,
    WebModel,
)

PlanMode = Literal["ai_plan", "ai_optimize", "tasks_only"]

PLAN_KEYS = frozenset(
    [
        "schedule_strategy",
        "tasks",
        "availability_rules",
        "fixed_events",
        "scheduled_blocks",
        "deleted_ids",
    ]
)

_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

MODE_LABELS: dict[str, str] = {
    "ai_plan": "AI 制定新计划",
    "ai_optimize": "AI 优化现有计划",
    "tasks_only": "AI 整理任务、本地排程",
}

MODE_LABELS_EN: dict[str, str] = {
    "ai_plan": "AI builds a new plan",
    "ai_optimize": "AI optimizes the existing plan",
    "tasks_only": "AI tidies tasks, local scheduler plans",
}


class PlanRejected(ValueError):
    """Raised when a pasted reply cannot be turned into exactly one plan."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


# ---- plan JSON models (snake_case, what the external AI returns) ----


class PlanTask(WebModel):
    id: str = Field(min_length=1)
    title: Optional[str] = None
    type: Optional[TaskType] = None
    deadline: Optional[datetime] = None
    estimated_minutes: Optional[int] = Field(default=None, gt=0)
    earliest_start_at: Optional[datetime] = None
    priority: Optional[Priority] = None
    splittable: Optional[bool] = None
    notes: Optional[str] = None

    _tz = field_validator("deadline", "earliest_start_at")(
        classmethod(lambda cls, v: None if v is None else _require_tz(v))
    )


class PlanAvailabilityRule(WebModel):
    id: str = Field(min_length=1)
    weekday: int = Field(ge=0, le=6)  # 0 = Sunday (JS convention)
    start_time: str
    end_time: str

    @model_validator(mode="after")
    def _check(self) -> "PlanAvailabilityRule":
        for value in (self.start_time, self.end_time):
            if not _HHMM.match(value):
                raise ValueError(f"time must be HH:MM, got {value!r}")
        if self.start_time >= self.end_time:
            raise ValueError("start_time must be before end_time")
        return self


class PlanFixedEvent(WebModel):
    id: str = Field(min_length=1)
    title: Optional[str] = None
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None

    _tz = field_validator("start_at", "end_at")(
        classmethod(lambda cls, v: None if v is None else _require_tz(v))
    )


class PlanBlock(WebModel):
    id: Optional[str] = None
    task_id: str = Field(min_length=1)
    start_at: datetime
    end_at: datetime

    _tz = field_validator("start_at", "end_at")(classmethod(lambda cls, v: _require_tz(v)))

    @model_validator(mode="after")
    def _check_order(self) -> "PlanBlock":
        if self.start_at >= self.end_at:
            raise ValueError("start_at must be before end_at")
        return self


class AiPlan(WebModel):
    schedule_strategy: Optional[Literal["ai_blocks", "local_auto"]] = None
    tasks: list[PlanTask] = Field(default_factory=list)
    availability_rules: list[PlanAvailabilityRule] = Field(default_factory=list)
    fixed_events: list[PlanFixedEvent] = Field(default_factory=list)
    scheduled_blocks: list[PlanBlock] = Field(default_factory=list)
    deleted_ids: list[str] = Field(default_factory=list)


# ---- preview / change models (camelCase, what the frontend renders) ----


ChangeKind = Literal[
    "task_add", "task_update", "task_delete",
    "event_add", "event_update", "event_delete",
    "availability_add", "availability_update", "availability_delete",
    "block_add", "block_move", "block_remove",
]


class FieldChange(WebModel):
    field: str
    old: Optional[Any] = None
    new: Optional[Any] = None


class PlanChange(WebModel):
    changeId: str
    kind: ChangeKind
    targetId: str
    summary: str
    fields: list[FieldChange] = Field(default_factory=list)
    dependsOn: list[str] = Field(default_factory=list)


class KeptBlock(WebModel):
    id: str
    taskId: str
    startAt: datetime
    endAt: datetime
    reason: str  # manual | locked | done | past | not_replaced


# ---- state snapshot ----


@dataclass
class WebState:
    tasks: list[Task]
    blocks: list[ScheduledBlock]
    availability: list[AvailabilityWindow]
    events: list[FixedEvent]
    settings: Settings


def state_version(state: WebState) -> str:
    """Stable fingerprint of everything a preview depends on."""
    payload = json.dumps(
        {
            "tasks": sorted(t.model_dump_json() for t in state.tasks),
            "blocks": sorted(b.model_dump_json() for b in state.blocks),
            "availability": sorted(w.model_dump_json() for w in state.availability),
            "events": sorted(e.model_dump_json() for e in state.events),
            "settings": state.settings.model_dump_json(),
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# ---- lenient JSON extraction ----


def _match_brace(text: str, start: int) -> Optional[int]:
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    return None


def extract_plan(text: str) -> AiPlan:
    """Find exactly one valid plan JSON in the reply, else raise PlanRejected.

    Accepts pure JSON, fenced code blocks and JSON embedded in prose. Multiple
    valid candidates (or none) abort the import instead of guessing.
    """
    if not text.strip():
        raise PlanRejected(["回复为空"])
    plans: list[AiPlan] = []
    shaped_errors: list[str] = []
    index = 0
    while index < len(text):
        if text[index] != "{":
            index += 1
            continue
        end = _match_brace(text, index)
        if end is None:
            index += 1
            continue
        candidate = text[index : end + 1]
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            index += 1
            continue
        index = end + 1
        if not isinstance(data, dict) or not (PLAN_KEYS & set(data)):
            continue
        try:
            plans.append(AiPlan.model_validate(data))
        except ValidationError as exc:
            shaped_errors.extend(
                f"{'.'.join(str(loc) for loc in err['loc']) or '<root>'}: {err['msg']}"
                for err in exc.errors()
            )
    if len(plans) == 1:
        return plans[0]
    if len(plans) > 1:
        raise PlanRejected(["回复中包含多个有效的计划 JSON，无法自动选择，请只保留一个"])
    if shaped_errors:
        raise PlanRejected(shaped_errors)
    raise PlanRejected(
        ["回复中未找到计划 JSON（支持纯 JSON、```json 代码块或附带说明文字的单个 JSON）"]
    )


# ---- prompt ----

_MODE_RULES: dict[str, str] = {
    "ai_plan": (
        "制定一份全新计划：综合全部 active 任务，既可以修改任务属性，也必须在 "
        "scheduled_blocks 中给出具体时间块。系统会删除未来、未锁定的机器安排"
        "（source 为 ai 或 local_auto）并替换为你的时间块。"
    ),
    "ai_optimize": (
        "优化现有计划：保留所有受保护时间块（过去、已完成、手动、锁定，以及本地"
        "算法 local_auto 的时间块），只重新规划未来、未锁定、source 为 ai 的时间块。"
        "受保护时间块是硬约束，你的时间块不得与它们重叠。"
    ),
    "tasks_only": (
        "只整理任务：可以新增/更新/删除任务、可用时间和固定事件，但不要返回 "
        "scheduled_blocks（本地确定性算法会自动排程）。"
    ),
}

_MODE_RULES_EN: dict[str, str] = {
    "ai_plan": (
        "Build a brand-new plan: consider every active task. You may edit task "
        "attributes and you must place concrete time blocks in scheduled_blocks. "
        "The system removes future, unlocked machine blocks (source ai or "
        "local_auto) and replaces them with yours."
    ),
    "ai_optimize": (
        "Optimize the existing plan: keep all protected blocks (past, done, "
        "manual, locked, and local_auto blocks), and only re-plan future, "
        "unlocked blocks whose source is ai. Protected blocks are hard "
        "constraints; your blocks must not overlap them."
    ),
    "tasks_only": (
        "Only tidy tasks: you may add/update/delete tasks, availability and "
        "fixed events, but do not return scheduled_blocks (the local "
        "deterministic scheduler will plan them)."
    ),
}


def _build_plan_prompt_en(
    mode: PlanMode,
    requirements_text: str,
    active_tasks: list,
    availability: list,
    events: list,
    future_blocks: list,
    schema: str,
    state: WebState,
    now: datetime,
) -> str:
    return f"""You are the planning brain of a local-first deadline planner. The tool never goes online; the user pastes your JSON back into the tool, where it is validated and previewed before being written.

Current time: {now.isoformat()}
Time zone: {now.tzinfo}
Daily planned cap: {state.settings.dailyMaxPlannedHours} hours (task blocks only; fixed events excluded)
Mode: {MODE_LABELS_EN[mode]}

## Mode rules
{_MODE_RULES_EN[mode]}

## Current data (matched by id; same id = update, new id = add, deletions must go in deleted_ids)
### active tasks
{json.dumps(active_tasks, indent=2, ensure_ascii=False)}
### availability rules (weekday: 0=Sunday … 6=Saturday; with no rules the default is 09:00-17:00 daily)
{json.dumps(availability, indent=2, ensure_ascii=False)}
### fixed events
{json.dumps(events, indent=2, ensure_ascii=False)}
### future blocks (protected=true blocks are never removed; your blocks must not overlap them)
{json.dumps(future_blocks, indent=2, ensure_ascii=False)}

## User requirements for this run
{requirements_text}

## Output rules
- Output a single JSON object (optionally inside a ```json code block, with brief surrounding text, but only one plan JSON).
- Top-level fields: schedule_strategy, tasks, availability_rules, fixed_events, scheduled_blocks, deleted_ids — all optional; omitted records stay unchanged, so do not repeat unmodified records.
- Every datetime must be ISO 8601 with a UTC offset.
- New tasks must carry a unique id; scheduled_blocks reference tasks via task_id (may reference tasks created in the same reply).
- Each block must: avoid fixed events, unavailable time and protected blocks; not start before the task's earliest_start_at; end before the task's deadline (no limit when the task has none); not overlap other blocks in this batch; not be earlier than the current time.
- Try to respect the daily planned cap; exceeding it produces a warning in the preview.
- Do not invent fields; unknown fields are rejected.

## JSON Schema
{schema}
"""


def build_plan_prompt(
    mode: PlanMode,
    requirements: str,
    state: WebState,
    now: datetime,
    language: str = "zh-CN",
) -> str:
    tz = now.tzinfo
    active_tasks = [
        {
            "id": t.id,
            "title": t.title,
            "deadline": t.deadline.isoformat() if t.deadline else None,
            "estimated_minutes": t.estimatedMinutes,
            "priority": t.priority,
            "earliest_start_at": t.earliestStartAt.isoformat() if t.earliestStartAt else None,
            "splittable": t.splittable,
            "notes": t.notes,
        }
        for t in state.tasks
        if t.status == "active"
    ]
    availability = [
        {"id": w.id, "weekday": w.weekday, "start_time": w.startTime, "end_time": w.endTime}
        for w in state.availability
    ]
    events = [
        {
            "id": e.id,
            "title": e.title,
            "start_at": e.startAt.isoformat(),
            "end_at": e.endAt.isoformat(),
        }
        for e in state.events
    ]
    future_blocks = []
    for b in sorted(state.blocks, key=lambda b: b.startAt):
        if b.endAt < now:
            continue
        protected = _is_protected(b, now) or (
            mode == "ai_optimize" and b.source == "local_auto"
        )
        future_blocks.append(
            {
                "id": b.id,
                "task_id": b.taskId,
                "start_at": b.startAt.isoformat(),
                "end_at": b.endAt.isoformat(),
                "source": b.source,
                "locked": b.locked,
                "done": b.done,
                "protected": protected,
            }
        )
    schema = json.dumps(AiPlan.model_json_schema(), indent=2, ensure_ascii=False)

    if language == "en-US":
        return _build_plan_prompt_en(
            mode,
            requirements.strip() or "(no extra requirements)",
            active_tasks,
            availability,
            events,
            future_blocks,
            schema,
            state,
            now,
        )

    requirements_text = requirements.strip() or "（无额外要求）"

    return f"""你是一个本地截止日期规划工具的规划大脑。工具本身不联网；用户会把你输出的 JSON 粘贴回工具，经校验和预览后写入。

当前时间：{now.isoformat()}
时区：{tz}
每日计划上限：{state.settings.dailyMaxPlannedHours} 小时（任务时间块合计，固定事件不计入）
本次模式：{MODE_LABELS[mode]}

## 模式规则
{_MODE_RULES[mode]}

## 当前数据（按 id 精确匹配；同一 id 表示更新，新 id 表示新增，删除必须写入 deleted_ids）
### active 任务
{json.dumps(active_tasks, indent=2, ensure_ascii=False)}
### 可用时间规则（weekday：0=周日 … 6=周六；没有任何规则时每天默认 09:00-17:00）
{json.dumps(availability, indent=2, ensure_ascii=False)}
### 固定事件
{json.dumps(events, indent=2, ensure_ascii=False)}
### 未来时间块（protected=true 的不会被移除，你的时间块不得与其重叠）
{json.dumps(future_blocks, indent=2, ensure_ascii=False)}

## 用户本次要求
{requirements_text}

## 输出规则
- 输出一个 JSON 对象（可以放在 ```json 代码块中，前后可以有简短说明，但只能包含一个计划 JSON）。
- 顶层字段：schedule_strategy、tasks、availability_rules、fixed_events、scheduled_blocks、deleted_ids，均可省略；省略的记录保持不变，不要重复返回未修改的记录。
- 所有 datetime 必须是带 UTC 偏移的 ISO 8601。
- 新任务必须自带唯一 id；scheduled_blocks 通过 task_id 引用任务（可以引用同一回复中新建的任务）。
- 每个时间块必须：避开固定事件、不可用时间和受保护时间块；不早于任务 earliest_start_at；在任务 deadline 前结束（任务无 deadline 时不受此限）；不与同批次其他时间块重叠；不早于当前时间。
- 尽量遵守每日计划上限；超出会在预览中产生警告。
- 不要发明字段；未知字段会被拒绝。

## JSON Schema
{schema}
"""


# ---- scenario (preview + final-state validation) ----


@dataclass
class Scenario:
    changes: list[PlanChange] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    effective_ids: set[str] = field(default_factory=set)
    kept_blocks: list[KeptBlock] = field(default_factory=list)
    final_tasks: dict[str, Task] = field(default_factory=dict)
    final_events: dict[str, FixedEvent] = field(default_factory=dict)
    final_availability: dict[str, AvailabilityWindow] = field(default_factory=dict)
    final_blocks: dict[str, ScheduledBlock] = field(default_factory=dict)
    use_local_scheduler: bool = False


def _is_protected(block: ScheduledBlock, now: datetime) -> bool:
    return block.done or block.locked or block.source == "manual" or block.startAt < now


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and b_start < a_end


def _minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


_TASK_FIELD_MAP = {
    "title": "title",
    "type": "type",
    "deadline": "deadline",
    "estimated_minutes": "estimatedMinutes",
    "earliest_start_at": "earliestStartAt",
    "priority": "priority",
    "splittable": "splittable",
    "notes": "notes",
}

_WEEKDAY_CN = "日一二三四五六"


def _display(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def _generated_block_id(item: PlanBlock) -> str:
    return item.id or f"ai-{item.task_id}-{item.start_at.strftime('%Y%m%dT%H%M%z')}"


def _task_changes(
    plan: AiPlan, tasks_by_id: dict[str, Task], now: datetime,
    changes: list[PlanChange], errors: list[str],
) -> dict[str, Task]:
    """Per-task add/update changes; returns the would-be task per change id."""
    proposed: dict[str, Task] = {}
    seen: set[str] = set()
    for item in plan.tasks:
        if item.id in seen:
            errors.append(f"tasks 中出现重复 id：{item.id}")
            continue
        seen.add(item.id)
        provided = item.model_dump(exclude_unset=True, exclude={"id"})
        existing = tasks_by_id.get(item.id)
        if existing is None:
            missing = [
                name
                for name in ("title", "estimated_minutes")
                if provided.get(name) is None
            ]
            if missing:
                errors.append(f"新任务 {item.id} 缺少必填字段：{', '.join(missing)}")
                continue
            new_task = Task(
                id=item.id,
                title=item.title,
                type=item.type or "other",
                deadline=item.deadline,
                estimatedMinutes=item.estimated_minutes,
                earliestStartAt=item.earliest_start_at,
                priority=item.priority or "medium",
                splittable=True if item.splittable is None else item.splittable,
                notes=item.notes,
                status="active",
                createdAt=now,
            )
            change_id = f"task:{item.id}"
            changes.append(
                PlanChange(
                    changeId=change_id,
                    kind="task_add",
                    targetId=item.id,
                    summary=f"新增任务「{new_task.title}」",
                    fields=[
                        FieldChange(field=camel, new=_display(getattr(new_task, camel)))
                        for snake, camel in _TASK_FIELD_MAP.items()
                        if provided.get(snake) is not None
                    ],
                )
            )
            proposed[change_id] = new_task
        else:
            diffs: list[FieldChange] = []
            updates: dict[str, Any] = {}
            for snake, camel in _TASK_FIELD_MAP.items():
                if snake not in provided:
                    continue
                old_value = getattr(existing, camel)
                new_value = provided[snake]
                if old_value == new_value:
                    continue
                updates[camel] = new_value
                diffs.append(
                    FieldChange(field=camel, old=_display(old_value), new=_display(new_value))
                )
            if not diffs:
                continue
            change_id = f"task:{item.id}"
            changes.append(
                PlanChange(
                    changeId=change_id,
                    kind="task_update",
                    targetId=item.id,
                    summary=f"更新任务「{existing.title}」",
                    fields=diffs,
                )
            )
            proposed[change_id] = Task.model_validate(existing.model_dump() | updates)
    return proposed


def _event_changes(
    plan: AiPlan, events_by_id: dict[str, FixedEvent],
    changes: list[PlanChange], errors: list[str],
) -> dict[str, FixedEvent]:
    proposed: dict[str, FixedEvent] = {}
    for item in plan.fixed_events:
        existing = events_by_id.get(item.id)
        if existing is None:
            if item.title is None or item.start_at is None or item.end_at is None:
                errors.append(f"新固定事件 {item.id} 必须包含 title、start_at、end_at")
                continue
            if item.start_at >= item.end_at:
                errors.append(f"固定事件 {item.id} 的 start_at 必须早于 end_at")
                continue
            event = FixedEvent(
                id=item.id, title=item.title, startAt=item.start_at, endAt=item.end_at
            )
            change_id = f"event:{item.id}"
            changes.append(
                PlanChange(
                    changeId=change_id,
                    kind="event_add",
                    targetId=item.id,
                    summary=f"新增固定事件「{event.title}」",
                    fields=[
                        FieldChange(field="title", new=event.title),
                        FieldChange(field="startAt", new=_display(event.startAt)),
                        FieldChange(field="endAt", new=_display(event.endAt)),
                    ],
                )
            )
            proposed[change_id] = event
        else:
            updated = FixedEvent(
                id=item.id,
                title=item.title if item.title is not None else existing.title,
                startAt=item.start_at if item.start_at is not None else existing.startAt,
                endAt=item.end_at if item.end_at is not None else existing.endAt,
            )
            if updated.startAt >= updated.endAt:
                errors.append(f"固定事件 {item.id} 的 start_at 必须早于 end_at")
                continue
            diffs = [
                FieldChange(field=name, old=_display(old), new=_display(new))
                for name, old, new in (
                    ("title", existing.title, updated.title),
                    ("startAt", existing.startAt, updated.startAt),
                    ("endAt", existing.endAt, updated.endAt),
                )
                if old != new
            ]
            if not diffs:
                continue
            change_id = f"event:{item.id}"
            changes.append(
                PlanChange(
                    changeId=change_id,
                    kind="event_update",
                    targetId=item.id,
                    summary=f"更新固定事件「{existing.title}」",
                    fields=diffs,
                )
            )
            proposed[change_id] = updated
    return proposed


def _availability_changes(
    plan: AiPlan, windows_by_id: dict[str, AvailabilityWindow],
    changes: list[PlanChange],
) -> dict[str, AvailabilityWindow]:
    proposed: dict[str, AvailabilityWindow] = {}
    for item in plan.availability_rules:
        updated = AvailabilityWindow(
            id=item.id, weekday=item.weekday, startTime=item.start_time, endTime=item.end_time
        )
        existing = windows_by_id.get(item.id)
        if existing is not None and existing == updated:
            continue
        change_id = f"availability:{item.id}"
        diffs = [
            FieldChange(
                field=name,
                old=_display(getattr(existing, name)) if existing else None,
                new=_display(getattr(updated, name)),
            )
            for name in ("weekday", "startTime", "endTime")
            if existing is None or getattr(existing, name) != getattr(updated, name)
        ]
        changes.append(
            PlanChange(
                changeId=change_id,
                kind="availability_add" if existing is None else "availability_update",
                targetId=item.id,
                summary=(
                    f"{'新增' if existing is None else '更新'}可用时间 "
                    f"周{_WEEKDAY_CN[item.weekday]} {item.start_time}-{item.end_time}"
                ),
                fields=diffs,
            )
        )
        proposed[change_id] = updated
    return proposed


def _deletion_changes(
    plan: AiPlan, state: WebState, now: datetime,
    changes: list[PlanChange], errors: list[str], warnings: list[str],
) -> None:
    tasks_by_id = {t.id: t for t in state.tasks}
    events_by_id = {e.id: e for e in state.events}
    windows_by_id = {w.id: w for w in state.availability}
    blocks_by_id = {b.id: b for b in state.blocks}
    for deleted_id in plan.deleted_ids:
        if deleted_id in tasks_by_id:
            task = tasks_by_id[deleted_id]
            cascade = [b for b in state.blocks if b.taskId == deleted_id]
            protected_count = sum(1 for b in cascade if _is_protected(b, now))
            if protected_count:
                warnings.append(
                    f"删除任务「{task.title}」会连带移除 {protected_count} 个受保护时间块"
                )
            changes.append(
                PlanChange(
                    changeId=f"delete-task:{deleted_id}",
                    kind="task_delete",
                    targetId=deleted_id,
                    summary=(
                        f"删除任务「{task.title}」"
                        + (f"（连带移除 {len(cascade)} 个时间块）" if cascade else "")
                    ),
                )
            )
        elif deleted_id in events_by_id:
            changes.append(
                PlanChange(
                    changeId=f"delete-event:{deleted_id}",
                    kind="event_delete",
                    targetId=deleted_id,
                    summary=f"删除固定事件「{events_by_id[deleted_id].title}」",
                )
            )
        elif deleted_id in windows_by_id:
            window = windows_by_id[deleted_id]
            changes.append(
                PlanChange(
                    changeId=f"delete-availability:{deleted_id}",
                    kind="availability_delete",
                    targetId=deleted_id,
                    summary=(
                        f"删除可用时间 周{_WEEKDAY_CN[window.weekday]} "
                        f"{window.startTime}-{window.endTime}"
                    ),
                )
            )
        elif deleted_id in blocks_by_id:
            block = blocks_by_id[deleted_id]
            if _is_protected(block, now):
                errors.append(
                    f"时间块 {deleted_id} 受保护（过去/已完成/手动/锁定），不能删除"
                )
                continue
            changes.append(
                PlanChange(
                    changeId=f"block-remove:{deleted_id}",
                    kind="block_remove",
                    targetId=deleted_id,
                    summary=f"删除时间块 {block.startAt:%m-%d %H:%M}–{block.endAt:%H:%M}",
                )
            )
        else:
            errors.append(f"deleted_ids 中的 {deleted_id} 不存在")


def _filter_effective(changes: list[PlanChange], accepted: Optional[set[str]]) -> set[str]:
    """Accepted ids minus changes whose dependencies were rejected."""
    all_ids = {c.changeId for c in changes}
    effective = set(all_ids if accepted is None else (accepted & all_ids))
    by_id = {c.changeId: c for c in changes}
    while True:
        dropped = {
            change_id
            for change_id in effective
            if any(dep not in effective for dep in by_id[change_id].dependsOn)
        }
        if not dropped:
            return effective
        effective -= dropped


def build_scenario(
    state: WebState,
    plan: AiPlan,
    mode: PlanMode,
    now: datetime,
    accepted: Optional[set[str]] = None,
) -> Scenario:
    """Compute all changes, then the final state for the accepted subset.

    ``accepted=None`` means "all changes" (the preview default). Block
    placements are always validated against the accepted final state, so a
    rejected removal that now collides with an accepted new block is an error.
    """
    scenario = Scenario()
    changes, errors, warnings = scenario.changes, scenario.errors, scenario.warnings

    if mode == "tasks_only" and plan.scheduled_blocks:
        errors.append("本地排程模式不接受 scheduled_blocks，请让 AI 只返回任务相关修改")
    if plan.schedule_strategy == "local_auto" and plan.scheduled_blocks:
        errors.append("schedule_strategy 为 local_auto 时不应返回 scheduled_blocks")
    scenario.use_local_scheduler = (
        mode == "tasks_only" or plan.schedule_strategy == "local_auto"
    )

    tasks_by_id = {t.id: t for t in state.tasks}
    events_by_id = {e.id: e for e in state.events}
    windows_by_id = {w.id: w for w in state.availability}
    blocks_by_id = {b.id: b for b in state.blocks}

    proposed_tasks = _task_changes(plan, tasks_by_id, now, changes, errors)
    proposed_events = _event_changes(plan, events_by_id, changes, errors)
    proposed_windows = _availability_changes(plan, windows_by_id, changes)
    _deletion_changes(plan, state, now, changes, errors, warnings)

    deleted_task_ids = {c.targetId for c in changes if c.kind == "task_delete"}
    new_task_change_ids = {c.targetId: c.changeId for c in changes if c.kind == "task_add"}

    # Machine blocks the chosen mode is allowed to replace.
    replace_sources = {"ai", "local_auto"} if mode == "ai_plan" else {"ai"}
    if not scenario.use_local_scheduler:
        for block in state.blocks:
            if (
                not _is_protected(block, now)
                and block.source in replace_sources
                and block.taskId not in deleted_task_ids
            ):
                changes.append(
                    PlanChange(
                        changeId=f"block-remove:{block.id}",
                        kind="block_remove",
                        targetId=block.id,
                        summary=(
                            f"移除旧时间块 {block.startAt:%m-%d %H:%M}–{block.endAt:%H:%M}"
                            f"（{block.source}）"
                        ),
                    )
                )

    # Plan blocks: an existing id is a move, anything else is an add.
    seen_block_ids: set[str] = set()
    plan_block_changes: list[tuple[PlanChange, PlanBlock]] = []
    proposed_new_task_ids = {t.id for t in proposed_tasks.values()}
    for item in plan.scheduled_blocks:
        block_id = _generated_block_id(item)
        if block_id in seen_block_ids:
            errors.append(f"scheduled_blocks 中出现重复时间块 id：{block_id}")
            continue
        seen_block_ids.add(block_id)
        if item.task_id not in tasks_by_id and item.task_id not in proposed_new_task_ids:
            errors.append(f"时间块引用了未知任务 id：{item.task_id}")
            continue
        if item.task_id in deleted_task_ids:
            errors.append(f"时间块引用了本次删除的任务：{item.task_id}")
            continue
        depends = (
            [new_task_change_ids[item.task_id]]
            if item.task_id in new_task_change_ids
            else []
        )
        existing_block = blocks_by_id.get(block_id)
        if existing_block is not None:
            if _is_protected(existing_block, now):
                errors.append(
                    f"时间块 {block_id} 受保护（过去/已完成/手动/锁定），不能移动"
                )
                continue
            if (existing_block.startAt, existing_block.endAt) == (item.start_at, item.end_at):
                # unchanged: cancel the replacement sweep's removal, keep as-is
                changes[:] = [c for c in changes if c.changeId != f"block-remove:{block_id}"]
                continue
            change = PlanChange(
                changeId=f"block-move:{block_id}",
                kind="block_move",
                targetId=block_id,
                summary=(
                    f"移动时间块 {existing_block.startAt:%m-%d %H:%M} → "
                    f"{item.start_at:%m-%d %H:%M}"
                ),
                fields=[
                    FieldChange(
                        field="startAt",
                        old=_display(existing_block.startAt),
                        new=_display(item.start_at),
                    ),
                    FieldChange(
                        field="endAt",
                        old=_display(existing_block.endAt),
                        new=_display(item.end_at),
                    ),
                ],
                dependsOn=depends,
            )
        else:
            change = PlanChange(
                changeId=f"block-add:{block_id}",
                kind="block_add",
                targetId=block_id,
                summary=(
                    f"新增时间块 {item.start_at:%m-%d %H:%M}–{item.end_at:%H:%M}"
                    f"（任务 {item.task_id}）"
                ),
                fields=[
                    FieldChange(field="taskId", new=item.task_id),
                    FieldChange(field="startAt", new=_display(item.start_at)),
                    FieldChange(field="endAt", new=_display(item.end_at)),
                ],
                dependsOn=depends,
            )
        # a moved block must not also be removed by the replacement sweep
        changes[:] = [c for c in changes if c.changeId != f"block-remove:{block_id}"]
        changes.append(change)
        plan_block_changes.append((change, item))

    effective = _filter_effective(changes, accepted)
    scenario.effective_ids = effective

    # ---- materialize the final state for the accepted subset ----
    final_tasks = dict(tasks_by_id)
    final_events = dict(events_by_id)
    final_windows = dict(windows_by_id)
    final_blocks = dict(blocks_by_id)
    for change in changes:
        if change.changeId not in effective:
            continue
        if change.kind in ("task_add", "task_update"):
            final_tasks[change.targetId] = proposed_tasks[change.changeId]
        elif change.kind == "task_delete":
            final_tasks.pop(change.targetId, None)
            for block in state.blocks:
                if block.taskId == change.targetId:
                    final_blocks.pop(block.id, None)
        elif change.kind in ("event_add", "event_update"):
            final_events[change.targetId] = proposed_events[change.changeId]
        elif change.kind == "event_delete":
            final_events.pop(change.targetId, None)
        elif change.kind in ("availability_add", "availability_update"):
            final_windows[change.targetId] = proposed_windows[change.changeId]
        elif change.kind == "availability_delete":
            final_windows.pop(change.targetId, None)
        elif change.kind == "block_remove":
            final_blocks.pop(change.targetId, None)
    new_or_moved: list[ScheduledBlock] = []
    for change, item in plan_block_changes:
        if change.changeId not in effective:
            continue
        block = ScheduledBlock(
            id=change.targetId,
            taskId=item.task_id,
            startAt=item.start_at,
            endAt=item.end_at,
            locked=False,
            source="ai",
            done=False,
        )
        final_blocks[block.id] = block
        new_or_moved.append(block)

    scenario.final_tasks = final_tasks
    scenario.final_events = final_events
    scenario.final_availability = final_windows
    scenario.final_blocks = final_blocks

    # blocks that survive untouched, with the reason they were kept
    moved_ids = {b.id for b in new_or_moved}
    for block in state.blocks:
        if block.id not in final_blocks or block.id in moved_ids or block.endAt < now:
            continue
        if block.done:
            reason = "done"
        elif block.source == "manual":
            reason = "manual"
        elif block.locked:
            reason = "locked"
        elif block.startAt < now:
            reason = "past"
        else:
            reason = "not_replaced"
        scenario.kept_blocks.append(
            KeptBlock(
                id=block.id, taskId=block.taskId,
                startAt=block.startAt, endAt=block.endAt, reason=reason,
            )
        )

    _validate_placements(scenario, state, new_or_moved, now)
    return scenario


def _validate_placements(
    scenario: Scenario, state: WebState, new_blocks: list[ScheduledBlock], now: datetime
) -> None:
    """Hard rules for AI blocks, checked against the accepted final state."""
    errors, warnings = scenario.errors, scenario.warnings
    tz = now.tzinfo
    new_ids = {b.id for b in new_blocks}
    other_blocks = [b for b in scenario.final_blocks.values() if b.id not in new_ids]
    windows = list(scenario.final_availability.values())

    for block in new_blocks:
        label = f"时间块 {block.startAt.astimezone(tz):%m-%d %H:%M}"
        task = scenario.final_tasks.get(block.taskId)
        if task is None:
            errors.append(f"{label} 引用的任务 {block.taskId} 在本次变更后不存在")
            continue
        if block.startAt < now:
            errors.append(f"{label} 早于当前时间")
        if task.deadline and block.endAt > task.deadline:
            errors.append(f"{label} 晚于任务「{task.title}」的截止时间")
        if task.earliestStartAt and block.startAt < task.earliestStartAt:
            errors.append(f"{label} 早于任务「{task.title}」的允许开始时间")
        for event in scenario.final_events.values():
            if _overlaps(block.startAt, block.endAt, event.startAt, event.endAt):
                errors.append(f"{label} 与固定事件「{event.title}」重叠")
        for other in other_blocks:
            if _overlaps(block.startAt, block.endAt, other.startAt, other.endAt):
                errors.append(f"{label} 与已保留的时间块 {other.id} 重叠")
        for peer in new_blocks:
            if peer.id < block.id and _overlaps(
                block.startAt, block.endAt, peer.startAt, peer.endAt
            ):
                errors.append(f"{label} 与同批次时间块 {peer.id} 重叠")
        local_start = block.startAt.astimezone(tz)
        local_end = block.endAt.astimezone(tz)
        start_min = local_start.hour * 60 + local_start.minute
        end_min = (
            local_end.hour * 60 + local_end.minute
            if local_end.date() == local_start.date()
            else 24 * 60
        )
        if windows:
            day_windows = [
                (_minutes(w.startTime), _minutes(w.endTime))
                for w in windows
                if w.weekday == (local_start.weekday() + 1) % 7
            ]
        else:
            day_windows = [(9 * 60, 17 * 60)]
        if not any(ws <= start_min and end_min <= we for ws, we in day_windows):
            errors.append(f"{label} 超出可用时间窗口")

    # soft checks: daily cap and tasks that still lack enough scheduled time
    cap_minutes = state.settings.dailyMaxPlannedHours * 60
    minutes_by_day: dict[str, int] = {}
    scheduled_by_task: dict[str, int] = {}
    for block in scenario.final_blocks.values():
        length = int((block.endAt - block.startAt).total_seconds() // 60)
        scheduled_by_task[block.taskId] = scheduled_by_task.get(block.taskId, 0) + length
        if block.done or block.startAt < now:
            continue
        day_key = block.startAt.astimezone(tz).date().isoformat()
        minutes_by_day[day_key] = minutes_by_day.get(day_key, 0) + length
    for day_key in sorted(minutes_by_day):
        if minutes_by_day[day_key] > cap_minutes:
            warnings.append(
                f"{day_key} 计划 {minutes_by_day[day_key] / 60:.1f} 小时，"
                f"超过每日上限 {state.settings.dailyMaxPlannedHours} 小时"
            )
    if not scenario.use_local_scheduler:
        for task in scenario.final_tasks.values():
            if task.status != "active":
                continue
            scheduled = scheduled_by_task.get(task.id, 0)
            if scheduled < task.estimatedMinutes:
                warnings.append(
                    f"任务「{task.title}」尚有 {task.estimatedMinutes - scheduled} "
                    "分钟未排入日程"
                )


def change_summary(scenario: Scenario) -> dict[str, int]:
    counts: dict[str, int] = {}
    for change in scenario.changes:
        counts[change.kind] = counts.get(change.kind, 0) + 1
    return counts
