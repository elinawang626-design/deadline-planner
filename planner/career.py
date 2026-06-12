"""Career material cards: prompt building, strict JSON validation, Markdown export.

One card per task. The external AI returns structured material only (no full
resume); metrics it cannot ground in user-provided evidence must be marked
"待补充" rather than invented.
"""
from __future__ import annotations

import json
from datetime import datetime

from pydantic import Field, ValidationError

from planner.ai_plan import PlanRejected, _match_brace
from planner.extract import Excerpt, TOTAL_CHAR_BUDGET
from planner.trackmodels import CareerCard, ChecklistItem, WorkLog
from planner.webmodels import Task, WebModel

CARD_KEYS = frozenset(["context", "role", "actions"])


class CareerCardResult(WebModel):
    """What the external AI must return (snake_case, extras rejected)."""

    context: str = Field(min_length=1)
    role: str = Field(min_length=1)
    actions: list[str] = Field(default_factory=list)
    challenges: list[str] = Field(default_factory=list)
    outcomes: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    evidence_attachment_ids: list[str] = Field(default_factory=list)


def extract_card(text: str) -> CareerCardResult:
    """Find exactly one valid career card JSON in the reply, else raise."""
    if not text.strip():
        raise PlanRejected(["回复为空"])
    results: list[CareerCardResult] = []
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
        if not isinstance(data, dict) or not (CARD_KEYS & set(data)):
            continue
        try:
            results.append(CareerCardResult.model_validate(data))
        except ValidationError as exc:
            shaped_errors.extend(
                f"{'.'.join(str(loc) for loc in err['loc']) or '<root>'}: {err['msg']}"
                for err in exc.errors()
            )
    if len(results) == 1:
        return results[0]
    if len(results) > 1:
        raise PlanRejected(["回复中包含多个有效的素材卡 JSON，请只保留一个"])
    if shaped_errors:
        raise PlanRejected(shaped_errors)
    raise PlanRejected(["回复中未找到素材卡 JSON（需包含 context/role/actions）"])


def build_career_prompt(
    task: Task,
    checklist: list[ChecklistItem],
    worklogs: list[WorkLog],
    excerpts_by_attachment: dict[str, tuple[str, list[Excerpt]]],
    confirmed_metrics: str,
    now: datetime,
) -> str:
    """``excerpts_by_attachment`` maps attachmentId -> (displayName, excerpts)."""
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
            "result": w.result,
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
        CareerCardResult.model_json_schema(), indent=2, ensure_ascii=False
    )
    task_info = {
        "title": task.title,
        "description": task.description,
        "type": task.type,
        "status": task.status,
        "actual_minutes": actual_minutes,
    }

    return f"""你是一个本地任务规划工具的职业素材整理助手。工具不联网；用户会把你输出的 JSON 粘贴回工具校验后保存为该任务的职业素材卡。

当前时间：{now.isoformat()}

## 任务
{json.dumps(task_info, indent=2, ensure_ascii=False)}

## 检查项
{json.dumps(checklist_rows, indent=2, ensure_ascii=False) if checklist_rows else "（无）"}

## 工作记录（行动、困难与结果的事实来源）
{json.dumps(worklog_rows, indent=2, ensure_ascii=False) if worklog_rows else "（无）"}

## 附件资料片段
{attachments_text}

## 用户确认的指标
{confirmed_metrics.strip() or "（用户未提供；metrics 中缺失的数字一律写「待补充」，不得编造）"}

## 输出规则
- 输出一个 JSON 对象（可放在 ```json 代码块中，只能有一个素材卡 JSON）。
- 只返回结构化素材：context（背景）、role（个人角色）、actions（关键行动）、challenges（难点）、outcomes（解决方法与结果）、metrics（可量化指标）、skills（使用技能）、evidence_attachment_ids（支撑证据的附件 id）。
- 不要生成完整简历或自我评价段落。
- metrics 只能来自用户确认的指标、工作记录或附件证据；缺失的数字标记为「待补充」，严禁虚构。
- 不要发明字段；未知字段会被拒绝。

## JSON Schema
{schema}
"""


def card_to_markdown(card: CareerCard, task: Task) -> str:
    def bullets(items: list[str]) -> str:
        return "\n".join(f"- {item}" for item in items) or "- （无）"

    return f"""# 职业素材卡：{task.title}

## 背景
{card.context}

## 个人角色
{card.role}

## 关键行动
{bullets(card.actions)}

## 难点
{bullets(card.challenges)}

## 解决方法与结果
{bullets(card.outcomes)}

## 可量化指标
{bullets(card.metrics)}

## 使用技能
{bullets(card.skills)}

---
生成于 {card.updatedAt.isoformat()}；证据附件：{', '.join(card.evidenceAttachmentIds) or '无'}
"""
