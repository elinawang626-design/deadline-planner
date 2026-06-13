"""AI estimation: prompt building, strict JSON validation, history calibration.

Same workflow as planner.ai_plan — no LLM API. The user copies the generated
prompt to any external AI and pastes the JSON reply back; we validate it and
store it as one Estimate history record. Applying an estimate (writing
likelyMinutes into the task) is a separate explicit step in the API layer.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from pydantic import Field, ValidationError, model_validator

from planner.ai_plan import PlanRejected, _match_brace
from planner.extract import Excerpt, TOTAL_CHAR_BUDGET
from planner.trackmodels import ChecklistItem, Confidence, EstimateStep, WorkLog
from planner.webmodels import Task, WebModel

ESTIMATE_KEYS = frozenset(
    ["optimistic_minutes", "likely_minutes", "pessimistic_minutes"]
)


class EstimateResult(WebModel):
    """What the external AI must return (snake_case, extras rejected)."""

    optimistic_minutes: int = Field(gt=0)
    likely_minutes: int = Field(gt=0)
    pessimistic_minutes: int = Field(gt=0)
    confidence: Confidence
    breakdown: list[EstimateStep] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    used_attachment_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_order(self) -> "EstimateResult":
        if not (
            self.optimistic_minutes <= self.likely_minutes <= self.pessimistic_minutes
        ):
            raise ValueError(
                "must satisfy optimistic_minutes <= likely_minutes <= pessimistic_minutes"
            )
        return self


def extract_estimate(text: str) -> EstimateResult:
    """Find exactly one valid estimate JSON in the reply, else raise PlanRejected."""
    if not text.strip():
        raise PlanRejected(["回复为空"])
    results: list[EstimateResult] = []
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
        if not isinstance(data, dict) or not (ESTIMATE_KEYS & set(data)):
            continue
        try:
            results.append(EstimateResult.model_validate(data))
        except ValidationError as exc:
            shaped_errors.extend(
                f"{'.'.join(str(loc) for loc in err['loc']) or '<root>'}: {err['msg']}"
                for err in exc.errors()
            )
    if len(results) == 1:
        return results[0]
    if len(results) > 1:
        raise PlanRejected(["回复中包含多个有效的估时 JSON，请只保留一个"])
    if shaped_errors:
        raise PlanRejected(shaped_errors)
    raise PlanRejected(
        ["回复中未找到估时 JSON（需包含 optimistic_minutes/likely_minutes/pessimistic_minutes）"]
    )


# ---- history calibration (simple stats only, no model training) ----


class HistorySample(WebModel):
    title: str
    type: str
    estimatedMinutes: int
    likelyMinutes: Optional[int] = None  # applied AI estimate, when one exists
    actualMinutes: int
    checklistCount: int = 0
    overdue: bool = False


def history_stats(samples: list[HistorySample]) -> dict:
    """Average actual/estimated deviation ratio over completed同类任务."""
    ratios = [
        s.actualMinutes / s.estimatedMinutes for s in samples if s.estimatedMinutes > 0
    ]
    return {
        "sample_count": len(samples),
        "avg_actual_vs_estimated_ratio": (
            round(sum(ratios) / len(ratios), 2) if ratios else None
        ),
    }


# ---- prompt ----


def build_estimate_prompt(
    task: Task,
    checklist: list[ChecklistItem],
    worklogs: list[WorkLog],
    excerpts_by_attachment: dict[str, tuple[str, list[Excerpt]]],
    history: list[HistorySample],
    now: datetime,
) -> str:
    """Render task context + selected attachment excerpts + history into a prompt.

    ``excerpts_by_attachment`` maps attachmentId -> (displayName, excerpts).
    """
    checklist_rows = [
        {"title": c.title, "completed": c.completed}
        for c in sorted(checklist, key=lambda c: c.position)
    ]
    worklog_rows = [
        {
            "worked_at": w.workedAt.isoformat(),
            "duration_minutes": w.durationMinutes,
            "summary": w.summary,
            "challenge": w.challenge,
        }
        for w in sorted(worklogs, key=lambda w: w.workedAt)
    ]
    actual_minutes = sum(w.durationMinutes for w in worklogs)

    sections: list[str] = []
    used = 0
    for attachment_id, (display_name, excerpts) in excerpts_by_attachment.items():
        lines = [f"### 附件 {display_name}（id: {attachment_id}）"]
        for excerpt in excerpts:
            chunk = (
                f"[{excerpt.heading}] {excerpt.text}" if excerpt.heading else excerpt.text
            )
            if used + len(chunk) > TOTAL_CHAR_BUDGET:
                lines.append("（已达总字符预算，其余片段省略）")
                used = TOTAL_CHAR_BUDGET
                break
            used += len(chunk)
            lines.append(f"- {chunk}")
        sections.append("\n".join(lines))
    attachments_text = "\n\n".join(sections) or "（未选择任何附件）"

    schema = json.dumps(
        EstimateResult.model_json_schema(), indent=2, ensure_ascii=False
    )
    history_rows = [s.model_dump() for s in history]

    task_info = {
        "title": task.title,
        "description": task.description,
        "type": task.type,
        "deadline": task.deadline.isoformat() if task.deadline else None,
        "current_estimated_minutes": task.estimatedMinutes,
        "priority": task.priority,
        "notes": task.notes,
    }
    history_info = {"samples": history_rows, "statistics": history_stats(history)}

    return f"""你是一个本地任务规划工具的估时助手。工具不联网；用户会把你输出的 JSON 粘贴回工具校验后保存为估时记录。

当前时间：{now.isoformat()}

## 待估时任务
{json.dumps(task_info, indent=2, ensure_ascii=False)}

## 检查项
{json.dumps(checklist_rows, indent=2, ensure_ascii=False) if checklist_rows else "（无）"}

## 已有工作记录（实际已投入 {actual_minutes} 分钟）
{json.dumps(worklog_rows, indent=2, ensure_ascii=False) if worklog_rows else "（无）"}

## 附件资料片段（确定性筛选的高分片段，并非完整文档；估时时请注明依据的附件）
{attachments_text}

## 同类型任务历史（用于校准；statistics 为简单平均，不是预测模型）
{json.dumps(history_info, indent=2, ensure_ascii=False)}

## 输出规则
- 输出一个 JSON 对象（可放在 ```json 代码块中，前后可有简短说明，但只能有一个估时 JSON）。
- 必须包含 optimistic_minutes、likely_minutes、pessimistic_minutes（正整数，且乐观 <= 最可能 <= 悲观）、confidence（low/medium/high）。
- breakdown 给出分步骤时间构成；assumptions 列出假设；risks 列出可能拖慢进度的风险。
- used_attachment_ids 填写你实际参考过的附件 id（来自上方括号内的 id）。
- 不要发明字段；未知字段会被拒绝。

## JSON Schema
{schema}
"""
