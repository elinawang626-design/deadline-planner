/**
 * Pure TS port of the backend AI plan import (planner/ai_plan.py) so mock
 * mode follows the same parse / preview / import rules:
 * - lenient extraction: pure JSON, fenced block, or JSON inside prose, but
 *   exactly ONE valid plan candidate;
 * - per-record changes with field-level diffs;
 * - scenario validation against the accepted subset of changes;
 * - protected blocks (past / done / manual / locked) are never touched.
 */
import { format } from 'date-fns'
import type {
  AvailabilityWindow,
  FieldChange,
  FixedEvent,
  KeptBlock,
  PlanChange,
  PlanMode,
  Priority,
  ScheduledBlock,
  Settings,
  Task,
  TaskType,
} from '../types'

export interface PlanState {
  tasks: Task[]
  blocks: ScheduledBlock[]
  availability: AvailabilityWindow[]
  fixedEvents: FixedEvent[]
  settings: Settings
}

export interface PlanTaskJson {
  id: string
  title?: string
  type?: TaskType
  deadline?: string
  estimated_minutes?: number
  earliest_start_at?: string
  priority?: Priority
  splittable?: boolean
  notes?: string
}

export interface PlanAvailabilityJson {
  id: string
  weekday: number
  start_time: string
  end_time: string
}

export interface PlanEventJson {
  id: string
  title?: string
  start_at?: string
  end_at?: string
}

export interface PlanBlockJson {
  id?: string
  task_id: string
  start_at: string
  end_at: string
}

export interface AiPlanJson {
  schedule_strategy?: 'ai_blocks' | 'local_auto'
  tasks?: PlanTaskJson[]
  availability_rules?: PlanAvailabilityJson[]
  fixed_events?: PlanEventJson[]
  scheduled_blocks?: PlanBlockJson[]
  deleted_ids?: string[]
}

export interface Scenario {
  changes: PlanChange[]
  errors: string[]
  warnings: string[]
  effectiveIds: Set<string>
  keptBlocks: KeptBlock[]
  finalTasks: Map<string, Task>
  finalEvents: Map<string, FixedEvent>
  finalAvailability: Map<string, AvailabilityWindow>
  finalBlocks: Map<string, ScheduledBlock>
  useLocalScheduler: boolean
}

const PLAN_KEYS = [
  'schedule_strategy', 'tasks', 'availability_rules',
  'fixed_events', 'scheduled_blocks', 'deleted_ids',
]
const TASK_TYPES = [
  'assignment', 'exam', 'project', 'admin', 'personal', 'research', 'coding', 'other',
]
const PRIORITIES = ['low', 'medium', 'high', 'urgent']
const TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const WEEKDAY_CN = '日一二三四五六'

export const MODE_LABELS: Record<PlanMode, string> = {
  ai_plan: 'AI 制定新计划',
  ai_optimize: 'AI 优化现有计划',
  tasks_only: 'AI 整理任务、本地排程',
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && TZ_RE.test(value) && !Number.isNaN(Date.parse(value))
}

function fmt(iso: string): string {
  return format(new Date(iso), 'MM-dd HH:mm')
}

function fmtTime(iso: string): string {
  return format(new Date(iso), 'HH:mm')
}

function sameInstant(a?: string, b?: string): boolean {
  if (!a || !b) return a === b
  return new Date(a).getTime() === new Date(b).getTime()
}

// ---- structural validation (the mock's stand-in for pydantic) ----

function checkKeys(obj: Record<string, unknown>, allowed: string[], label: string): string[] {
  return Object.keys(obj)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${label}: 未知字段 ${key}`)
}

function validatePlanShape(data: Record<string, unknown>): string[] {
  const errors = checkKeys(data, PLAN_KEYS, '<root>')
  if (
    data.schedule_strategy !== undefined &&
    data.schedule_strategy !== 'ai_blocks' &&
    data.schedule_strategy !== 'local_auto'
  ) {
    errors.push('schedule_strategy 必须是 ai_blocks 或 local_auto')
  }
  for (const key of ['tasks', 'availability_rules', 'fixed_events', 'scheduled_blocks', 'deleted_ids']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      errors.push(`${key} 必须是数组`)
      return errors
    }
  }
  for (const [index, item] of ((data.tasks as unknown[]) ?? []).entries()) {
    const task = item as Record<string, unknown>
    const label = `tasks[${index}]`
    errors.push(
      ...checkKeys(task, ['id', 'title', 'type', 'deadline', 'estimated_minutes',
        'earliest_start_at', 'priority', 'splittable', 'notes'], label),
    )
    if (typeof task.id !== 'string' || !task.id) errors.push(`${label}.id 缺失`)
    if (task.deadline !== undefined && !isDateTime(task.deadline)) {
      errors.push(`${label}.deadline 必须是带时区偏移的 ISO 8601`)
    }
    if (task.earliest_start_at !== undefined && !isDateTime(task.earliest_start_at)) {
      errors.push(`${label}.earliest_start_at 必须是带时区偏移的 ISO 8601`)
    }
    if (
      task.estimated_minutes !== undefined &&
      (typeof task.estimated_minutes !== 'number' ||
        task.estimated_minutes <= 0 ||
        !Number.isInteger(task.estimated_minutes))
    ) {
      errors.push(`${label}.estimated_minutes 必须是正整数`)
    }
    if (task.priority !== undefined && !PRIORITIES.includes(task.priority as string)) {
      errors.push(`${label}.priority 必须是 low/medium/high/urgent`)
    }
    if (task.type !== undefined && !TASK_TYPES.includes(task.type as string)) {
      errors.push(`${label}.type 不合法`)
    }
  }
  for (const [index, item] of ((data.availability_rules as unknown[]) ?? []).entries()) {
    const rule = item as Record<string, unknown>
    const label = `availability_rules[${index}]`
    errors.push(...checkKeys(rule, ['id', 'weekday', 'start_time', 'end_time'], label))
    if (typeof rule.id !== 'string' || !rule.id) errors.push(`${label}.id 缺失`)
    if (typeof rule.weekday !== 'number' || rule.weekday < 0 || rule.weekday > 6) {
      errors.push(`${label}.weekday 必须是 0-6（0=周日）`)
    }
    if (!HHMM_RE.test(rule.start_time as string) || !HHMM_RE.test(rule.end_time as string)) {
      errors.push(`${label} 的时间必须是 HH:MM`)
    } else if ((rule.start_time as string) >= (rule.end_time as string)) {
      errors.push(`${label} 的 start_time 必须早于 end_time`)
    }
  }
  for (const [index, item] of ((data.fixed_events as unknown[]) ?? []).entries()) {
    const event = item as Record<string, unknown>
    const label = `fixed_events[${index}]`
    errors.push(...checkKeys(event, ['id', 'title', 'start_at', 'end_at'], label))
    if (typeof event.id !== 'string' || !event.id) errors.push(`${label}.id 缺失`)
    if (event.start_at !== undefined && !isDateTime(event.start_at)) {
      errors.push(`${label}.start_at 必须是带时区偏移的 ISO 8601`)
    }
    if (event.end_at !== undefined && !isDateTime(event.end_at)) {
      errors.push(`${label}.end_at 必须是带时区偏移的 ISO 8601`)
    }
  }
  for (const [index, item] of ((data.scheduled_blocks as unknown[]) ?? []).entries()) {
    const block = item as Record<string, unknown>
    const label = `scheduled_blocks[${index}]`
    errors.push(...checkKeys(block, ['id', 'task_id', 'start_at', 'end_at'], label))
    if (typeof block.task_id !== 'string' || !block.task_id) {
      errors.push(`${label}.task_id 缺失`)
    }
    if (!isDateTime(block.start_at) || !isDateTime(block.end_at)) {
      errors.push(`${label} 的 start_at/end_at 必须是带时区偏移的 ISO 8601`)
    } else if (new Date(block.start_at as string) >= new Date(block.end_at as string)) {
      errors.push(`${label} 的 start_at 必须早于 end_at`)
    }
  }
  for (const [index, value] of ((data.deleted_ids as unknown[]) ?? []).entries()) {
    if (typeof value !== 'string' || !value) errors.push(`deleted_ids[${index}] 必须是字符串`)
  }
  return errors
}

// ---- lenient extraction ----

function matchBrace(text: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return null
}

export function extractPlan(text: string): { plan: AiPlanJson | null; errors: string[] } {
  if (!text.trim()) return { plan: null, errors: ['回复为空'] }
  const plans: AiPlanJson[] = []
  const shapedErrors: string[] = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== '{') {
      index += 1
      continue
    }
    const end = matchBrace(text, index)
    if (end === null) {
      index += 1
      continue
    }
    const candidate = text.slice(index, end + 1)
    let data: unknown
    try {
      data = JSON.parse(candidate)
    } catch {
      index += 1
      continue
    }
    index = end + 1
    if (
      typeof data !== 'object' || data === null || Array.isArray(data) ||
      !PLAN_KEYS.some((key) => key in (data as Record<string, unknown>))
    ) {
      continue
    }
    const errors = validatePlanShape(data as Record<string, unknown>)
    if (errors.length) shapedErrors.push(...errors)
    else plans.push(data as AiPlanJson)
  }
  if (plans.length === 1) return { plan: plans[0], errors: [] }
  if (plans.length > 1) {
    return { plan: null, errors: ['回复中包含多个有效的计划 JSON，无法自动选择，请只保留一个'] }
  }
  if (shapedErrors.length) return { plan: null, errors: shapedErrors }
  return {
    plan: null,
    errors: ['回复中未找到计划 JSON（支持纯 JSON、```json 代码块或附带说明文字的单个 JSON）'],
  }
}

// ---- state fingerprint ----

export function stateVersion(state: PlanState): string {
  const payload = JSON.stringify({
    tasks: state.tasks.map((t) => JSON.stringify(t)).sort(),
    blocks: state.blocks.map((b) => JSON.stringify(b)).sort(),
    availability: state.availability.map((w) => JSON.stringify(w)).sort(),
    events: state.fixedEvents.map((e) => JSON.stringify(e)).sort(),
    settings: JSON.stringify(state.settings),
  })
  let hash = 5381
  for (let index = 0; index < payload.length; index++) {
    hash = ((hash * 33) ^ payload.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}

// ---- prompt ----

const MODE_RULES: Record<PlanMode, string> = {
  ai_plan:
    '制定一份全新计划：综合全部 active 任务，既可以修改任务属性，也必须在 scheduled_blocks 中给出具体时间块。' +
    '系统会删除未来、未锁定的机器安排（source 为 ai 或 local_auto）并替换为你的时间块。',
  ai_optimize:
    '优化现有计划：保留所有受保护时间块（过去、已完成、手动、锁定，以及本地算法 local_auto 的时间块），' +
    '只重新规划未来、未锁定、source 为 ai 的时间块。受保护时间块是硬约束，你的时间块不得与它们重叠。',
  tasks_only:
    '只整理任务：可以新增/更新/删除任务、可用时间和固定事件，但不要返回 scheduled_blocks（本地确定性算法会自动排程）。',
}

const PLAN_SCHEMA_TEXT = `{
  "schedule_strategy": "ai_blocks | local_auto（可选）",
  "tasks": [{"id": "必填", "title": "新任务必填", "deadline": "新任务必填，ISO 8601 带偏移",
             "estimated_minutes": "新任务必填，正整数", "priority": "low|medium|high|urgent",
             "earliest_start_at": "可选", "splittable": "可选布尔", "type": "可选", "notes": "可选"}],
  "availability_rules": [{"id": "必填", "weekday": "0-6（0=周日）", "start_time": "HH:MM", "end_time": "HH:MM"}],
  "fixed_events": [{"id": "必填", "title": "新事件必填", "start_at": "ISO 8601", "end_at": "ISO 8601"}],
  "scheduled_blocks": [{"id": "可选（已有 id 表示移动）", "task_id": "必填", "start_at": "ISO 8601", "end_at": "ISO 8601"}],
  "deleted_ids": ["要删除的任务/事件/可用时间/时间块 id"]
}`

function isProtected(block: ScheduledBlock, now: Date): boolean {
  return block.done || block.locked || block.source === 'manual' || new Date(block.startAt) < now
}

export function buildPrompt(
  mode: PlanMode, requirements: string, state: PlanState, now: Date,
): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const activeTasks = state.tasks
    .filter((t) => t.status === 'active')
    .map((t) => ({
      id: t.id, title: t.title, deadline: t.deadline,
      estimated_minutes: t.estimatedMinutes, priority: t.priority,
      earliest_start_at: t.earliestStartAt ?? null, splittable: t.splittable,
      notes: t.notes ?? null,
    }))
  const availability = state.availability.map((w) => ({
    id: w.id, weekday: w.weekday, start_time: w.startTime, end_time: w.endTime,
  }))
  const events = state.fixedEvents.map((e) => ({
    id: e.id, title: e.title, start_at: e.startAt, end_at: e.endAt,
  }))
  const futureBlocks = [...state.blocks]
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .filter((b) => new Date(b.endAt) >= now)
    .map((b) => ({
      id: b.id, task_id: b.taskId, start_at: b.startAt, end_at: b.endAt,
      source: b.source, locked: b.locked, done: b.done,
      protected: isProtected(b, now) || (mode === 'ai_optimize' && b.source === 'local_auto'),
    }))

  return [
    '你是一个本地截止日期规划工具的规划大脑。工具本身不联网；用户会把你输出的 JSON 粘贴回工具，经校验和预览后写入。',
    '',
    `当前时间：${now.toISOString()}`,
    `时区：${tz}`,
    `每日计划上限：${state.settings.dailyMaxPlannedHours} 小时（任务时间块合计，固定事件不计入）`,
    `本次模式：${MODE_LABELS[mode]}`,
    '',
    '## 模式规则',
    MODE_RULES[mode],
    '',
    '## 当前数据（按 id 精确匹配；同一 id 表示更新，新 id 表示新增，删除必须写入 deleted_ids）',
    '### active 任务',
    JSON.stringify(activeTasks, null, 2),
    '### 可用时间规则（weekday：0=周日 … 6=周六；没有任何规则时每天默认 09:00-17:00）',
    JSON.stringify(availability, null, 2),
    '### 固定事件',
    JSON.stringify(events, null, 2),
    '### 未来时间块（protected=true 的不会被移除，你的时间块不得与其重叠）',
    JSON.stringify(futureBlocks, null, 2),
    '',
    '## 用户本次要求',
    requirements.trim() || '（无额外要求）',
    '',
    '## 输出规则',
    '- 输出一个 JSON 对象（可以放在 ```json 代码块中，前后可以有简短说明，但只能包含一个计划 JSON）。',
    '- 顶层字段均可省略；省略的记录保持不变，不要重复返回未修改的记录。',
    '- 所有 datetime 必须是带 UTC 偏移的 ISO 8601。',
    '- 新任务必须自带唯一 id；scheduled_blocks 通过 task_id 引用任务（可以引用同一回复中新建的任务）。',
    '- 每个时间块必须：避开固定事件、不可用时间和受保护时间块；不早于任务 earliest_start_at；在任务 deadline 前结束；不与同批次其他时间块重叠；不早于当前时间。',
    '- 尽量遵守每日计划上限；超出会在预览中产生警告。',
    '- 不要发明字段；未知字段会被拒绝。',
    '',
    '## JSON Schema',
    PLAN_SCHEMA_TEXT,
  ].join('\n')
}

// ---- scenario ----

const TASK_FIELD_MAP: Array<[keyof PlanTaskJson, keyof Task]> = [
  ['title', 'title'],
  ['type', 'type'],
  ['deadline', 'deadline'],
  ['estimated_minutes', 'estimatedMinutes'],
  ['earliest_start_at', 'earliestStartAt'],
  ['priority', 'priority'],
  ['splittable', 'splittable'],
  ['notes', 'notes'],
]

function fieldEquals(camel: keyof Task, oldValue: unknown, newValue: unknown): boolean {
  if (camel === 'deadline' || camel === 'earliestStartAt') {
    return sameInstant(oldValue as string | undefined, newValue as string | undefined)
  }
  return oldValue === newValue
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd
}

export function buildScenario(
  state: PlanState,
  plan: AiPlanJson,
  mode: PlanMode,
  now: Date,
  accepted?: Set<string>,
): Scenario {
  const changes: PlanChange[] = []
  const errors: string[] = []
  const warnings: string[] = []

  const planBlocks = plan.scheduled_blocks ?? []
  if (mode === 'tasks_only' && planBlocks.length) {
    errors.push('本地排程模式不接受 scheduled_blocks，请让 AI 只返回任务相关修改')
  }
  if (plan.schedule_strategy === 'local_auto' && planBlocks.length) {
    errors.push('schedule_strategy 为 local_auto 时不应返回 scheduled_blocks')
  }
  const useLocalScheduler = mode === 'tasks_only' || plan.schedule_strategy === 'local_auto'

  const tasksById = new Map(state.tasks.map((t) => [t.id, t]))
  const eventsById = new Map(state.fixedEvents.map((e) => [e.id, e]))
  const windowsById = new Map(state.availability.map((w) => [w.id, w]))
  const blocksById = new Map(state.blocks.map((b) => [b.id, b]))

  // task add / update
  const proposedTasks = new Map<string, Task>()
  const seenTaskIds = new Set<string>()
  for (const item of plan.tasks ?? []) {
    if (seenTaskIds.has(item.id)) {
      errors.push(`tasks 中出现重复 id：${item.id}`)
      continue
    }
    seenTaskIds.add(item.id)
    const existing = tasksById.get(item.id)
    if (!existing) {
      const missing = (['title', 'deadline', 'estimated_minutes'] as const).filter(
        (name) => item[name] === undefined,
      )
      if (missing.length) {
        errors.push(`新任务 ${item.id} 缺少必填字段：${missing.join(', ')}`)
        continue
      }
      const newTask: Task = {
        id: item.id,
        title: item.title!,
        type: item.type ?? 'other',
        deadline: item.deadline!,
        estimatedMinutes: item.estimated_minutes!,
        earliestStartAt: item.earliest_start_at,
        priority: item.priority ?? 'medium',
        splittable: item.splittable ?? true,
        notes: item.notes,
        status: 'active',
        createdAt: now.toISOString(),
      }
      const changeId = `task:${item.id}`
      changes.push({
        changeId,
        kind: 'task_add',
        targetId: item.id,
        summary: `新增任务「${newTask.title}」`,
        fields: TASK_FIELD_MAP.filter(([snake]) => item[snake] !== undefined).map(
          ([, camel]): FieldChange => ({ field: camel, new: newTask[camel] }),
        ),
        dependsOn: [],
      })
      proposedTasks.set(changeId, newTask)
    } else {
      const diffs: FieldChange[] = []
      const updates: Partial<Task> = {}
      for (const [snake, camel] of TASK_FIELD_MAP) {
        if (item[snake] === undefined) continue
        const oldValue = existing[camel]
        const newValue = item[snake] as never
        if (fieldEquals(camel, oldValue, newValue)) continue
        ;(updates as Record<string, unknown>)[camel] = newValue
        diffs.push({ field: camel, old: oldValue, new: newValue })
      }
      if (!diffs.length) continue
      const changeId = `task:${item.id}`
      changes.push({
        changeId,
        kind: 'task_update',
        targetId: item.id,
        summary: `更新任务「${existing.title}」`,
        fields: diffs,
        dependsOn: [],
      })
      proposedTasks.set(changeId, { ...existing, ...updates })
    }
  }

  // fixed events add / update
  const proposedEvents = new Map<string, FixedEvent>()
  for (const item of plan.fixed_events ?? []) {
    const existing = eventsById.get(item.id)
    if (!existing) {
      if (item.title === undefined || item.start_at === undefined || item.end_at === undefined) {
        errors.push(`新固定事件 ${item.id} 必须包含 title、start_at、end_at`)
        continue
      }
      if (new Date(item.start_at) >= new Date(item.end_at)) {
        errors.push(`固定事件 ${item.id} 的 start_at 必须早于 end_at`)
        continue
      }
      const event: FixedEvent = {
        id: item.id, title: item.title, startAt: item.start_at, endAt: item.end_at,
      }
      const changeId = `event:${item.id}`
      changes.push({
        changeId,
        kind: 'event_add',
        targetId: item.id,
        summary: `新增固定事件「${event.title}」`,
        fields: [
          { field: 'title', new: event.title },
          { field: 'startAt', new: event.startAt },
          { field: 'endAt', new: event.endAt },
        ],
        dependsOn: [],
      })
      proposedEvents.set(changeId, event)
    } else {
      const updated: FixedEvent = {
        id: item.id,
        title: item.title ?? existing.title,
        startAt: item.start_at ?? existing.startAt,
        endAt: item.end_at ?? existing.endAt,
      }
      if (new Date(updated.startAt) >= new Date(updated.endAt)) {
        errors.push(`固定事件 ${item.id} 的 start_at 必须早于 end_at`)
        continue
      }
      const diffs: FieldChange[] = []
      if (updated.title !== existing.title) {
        diffs.push({ field: 'title', old: existing.title, new: updated.title })
      }
      if (!sameInstant(updated.startAt, existing.startAt)) {
        diffs.push({ field: 'startAt', old: existing.startAt, new: updated.startAt })
      }
      if (!sameInstant(updated.endAt, existing.endAt)) {
        diffs.push({ field: 'endAt', old: existing.endAt, new: updated.endAt })
      }
      if (!diffs.length) continue
      const changeId = `event:${item.id}`
      changes.push({
        changeId,
        kind: 'event_update',
        targetId: item.id,
        summary: `更新固定事件「${existing.title}」`,
        fields: diffs,
        dependsOn: [],
      })
      proposedEvents.set(changeId, updated)
    }
  }

  // availability add / update
  const proposedWindows = new Map<string, AvailabilityWindow>()
  for (const item of plan.availability_rules ?? []) {
    const updated: AvailabilityWindow = {
      id: item.id, weekday: item.weekday, startTime: item.start_time, endTime: item.end_time,
    }
    const existing = windowsById.get(item.id)
    if (
      existing &&
      existing.weekday === updated.weekday &&
      existing.startTime === updated.startTime &&
      existing.endTime === updated.endTime
    ) {
      continue
    }
    const changeId = `availability:${item.id}`
    changes.push({
      changeId,
      kind: existing ? 'availability_update' : 'availability_add',
      targetId: item.id,
      summary: `${existing ? '更新' : '新增'}可用时间 周${WEEKDAY_CN[item.weekday]} ${item.start_time}-${item.end_time}`,
      fields: (['weekday', 'startTime', 'endTime'] as const)
        .filter((name) => !existing || existing[name] !== updated[name])
        .map((name) => ({ field: name, old: existing?.[name], new: updated[name] })),
      dependsOn: [],
    })
    proposedWindows.set(changeId, updated)
  }

  // deletions
  for (const deletedId of plan.deleted_ids ?? []) {
    if (tasksById.has(deletedId)) {
      const task = tasksById.get(deletedId)!
      const cascade = state.blocks.filter((b) => b.taskId === deletedId)
      const protectedCount = cascade.filter((b) => isProtected(b, now)).length
      if (protectedCount) {
        warnings.push(`删除任务「${task.title}」会连带移除 ${protectedCount} 个受保护时间块`)
      }
      changes.push({
        changeId: `delete-task:${deletedId}`,
        kind: 'task_delete',
        targetId: deletedId,
        summary:
          `删除任务「${task.title}」` +
          (cascade.length ? `（连带移除 ${cascade.length} 个时间块）` : ''),
        fields: [],
        dependsOn: [],
      })
    } else if (eventsById.has(deletedId)) {
      changes.push({
        changeId: `delete-event:${deletedId}`,
        kind: 'event_delete',
        targetId: deletedId,
        summary: `删除固定事件「${eventsById.get(deletedId)!.title}」`,
        fields: [],
        dependsOn: [],
      })
    } else if (windowsById.has(deletedId)) {
      const window = windowsById.get(deletedId)!
      changes.push({
        changeId: `delete-availability:${deletedId}`,
        kind: 'availability_delete',
        targetId: deletedId,
        summary: `删除可用时间 周${WEEKDAY_CN[window.weekday]} ${window.startTime}-${window.endTime}`,
        fields: [],
        dependsOn: [],
      })
    } else if (blocksById.has(deletedId)) {
      const block = blocksById.get(deletedId)!
      if (isProtected(block, now)) {
        errors.push(`时间块 ${deletedId} 受保护（过去/已完成/手动/锁定），不能删除`)
        continue
      }
      changes.push({
        changeId: `block-remove:${deletedId}`,
        kind: 'block_remove',
        targetId: deletedId,
        summary: `删除时间块 ${fmt(block.startAt)}–${fmtTime(block.endAt)}`,
        fields: [],
        dependsOn: [],
      })
    } else {
      errors.push(`deleted_ids 中的 ${deletedId} 不存在`)
    }
  }

  const deletedTaskIds = new Set(
    changes.filter((c) => c.kind === 'task_delete').map((c) => c.targetId),
  )
  const newTaskChangeIds = new Map(
    changes.filter((c) => c.kind === 'task_add').map((c) => [c.targetId, c.changeId]),
  )

  // replacement sweep for machine blocks
  const replaceSources = mode === 'ai_plan' ? ['ai', 'local_auto'] : ['ai']
  if (!useLocalScheduler) {
    for (const block of state.blocks) {
      if (
        !isProtected(block, now) &&
        replaceSources.includes(block.source) &&
        !deletedTaskIds.has(block.taskId)
      ) {
        changes.push({
          changeId: `block-remove:${block.id}`,
          kind: 'block_remove',
          targetId: block.id,
          summary: `移除旧时间块 ${fmt(block.startAt)}–${fmtTime(block.endAt)}（${block.source}）`,
          fields: [],
          dependsOn: [],
        })
      }
    }
  }

  // plan blocks: an existing id is a move, anything else is an add
  const seenBlockIds = new Set<string>()
  const planBlockChanges: Array<[PlanChange, PlanBlockJson]> = []
  const proposedTaskIds = new Set([...proposedTasks.values()].map((t) => t.id))
  const dropChange = (changeId: string) => {
    const index = changes.findIndex((c) => c.changeId === changeId)
    if (index >= 0) changes.splice(index, 1)
  }
  for (const item of planBlocks) {
    const blockId =
      item.id ?? `ai-${item.task_id}-${format(new Date(item.start_at), "yyyyMMdd'T'HHmm")}`
    if (seenBlockIds.has(blockId)) {
      errors.push(`scheduled_blocks 中出现重复时间块 id：${blockId}`)
      continue
    }
    seenBlockIds.add(blockId)
    if (!tasksById.has(item.task_id) && !proposedTaskIds.has(item.task_id)) {
      errors.push(`时间块引用了未知任务 id：${item.task_id}`)
      continue
    }
    if (deletedTaskIds.has(item.task_id)) {
      errors.push(`时间块引用了本次删除的任务：${item.task_id}`)
      continue
    }
    const dependsOn = newTaskChangeIds.has(item.task_id)
      ? [newTaskChangeIds.get(item.task_id)!]
      : []
    const existingBlock = blocksById.get(blockId)
    let change: PlanChange
    if (existingBlock) {
      if (isProtected(existingBlock, now)) {
        errors.push(`时间块 ${blockId} 受保护（过去/已完成/手动/锁定），不能移动`)
        continue
      }
      if (
        sameInstant(existingBlock.startAt, item.start_at) &&
        sameInstant(existingBlock.endAt, item.end_at)
      ) {
        dropChange(`block-remove:${blockId}`)
        continue
      }
      change = {
        changeId: `block-move:${blockId}`,
        kind: 'block_move',
        targetId: blockId,
        summary: `移动时间块 ${fmt(existingBlock.startAt)} → ${fmt(item.start_at)}`,
        fields: [
          { field: 'startAt', old: existingBlock.startAt, new: item.start_at },
          { field: 'endAt', old: existingBlock.endAt, new: item.end_at },
        ],
        dependsOn,
      }
    } else {
      change = {
        changeId: `block-add:${blockId}`,
        kind: 'block_add',
        targetId: blockId,
        summary: `新增时间块 ${fmt(item.start_at)}–${fmtTime(item.end_at)}（任务 ${item.task_id}）`,
        fields: [
          { field: 'taskId', new: item.task_id },
          { field: 'startAt', new: item.start_at },
          { field: 'endAt', new: item.end_at },
        ],
        dependsOn,
      }
    }
    dropChange(`block-remove:${blockId}`)
    changes.push(change)
    planBlockChanges.push([change, item])
  }

  // dependency-aware acceptance filter
  const allIds = new Set(changes.map((c) => c.changeId))
  const effective = new Set(
    accepted === undefined ? allIds : [...accepted].filter((id) => allIds.has(id)),
  )
  const byId = new Map(changes.map((c) => [c.changeId, c]))
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...effective]) {
      if (byId.get(id)!.dependsOn.some((dep) => !effective.has(dep))) {
        effective.delete(id)
        changed = true
      }
    }
  }

  // materialize the final state for the accepted subset
  const finalTasks = new Map(tasksById)
  const finalEvents = new Map(eventsById)
  const finalWindows = new Map(windowsById)
  const finalBlocks = new Map(blocksById)
  for (const change of changes) {
    if (!effective.has(change.changeId)) continue
    if (change.kind === 'task_add' || change.kind === 'task_update') {
      finalTasks.set(change.targetId, proposedTasks.get(change.changeId)!)
    } else if (change.kind === 'task_delete') {
      finalTasks.delete(change.targetId)
      for (const block of state.blocks) {
        if (block.taskId === change.targetId) finalBlocks.delete(block.id)
      }
    } else if (change.kind === 'event_add' || change.kind === 'event_update') {
      finalEvents.set(change.targetId, proposedEvents.get(change.changeId)!)
    } else if (change.kind === 'event_delete') {
      finalEvents.delete(change.targetId)
    } else if (change.kind === 'availability_add' || change.kind === 'availability_update') {
      finalWindows.set(change.targetId, proposedWindows.get(change.changeId)!)
    } else if (change.kind === 'availability_delete') {
      finalWindows.delete(change.targetId)
    } else if (change.kind === 'block_remove') {
      finalBlocks.delete(change.targetId)
    }
  }
  const newOrMoved: ScheduledBlock[] = []
  for (const [change, item] of planBlockChanges) {
    if (!effective.has(change.changeId)) continue
    const block: ScheduledBlock = {
      id: change.targetId,
      taskId: item.task_id,
      startAt: item.start_at,
      endAt: item.end_at,
      locked: false,
      source: 'ai',
      done: false,
    }
    finalBlocks.set(block.id, block)
    newOrMoved.push(block)
  }

  // kept blocks with the reason they survived
  const keptBlocks: KeptBlock[] = []
  const movedIds = new Set(newOrMoved.map((b) => b.id))
  for (const block of state.blocks) {
    if (!finalBlocks.has(block.id) || movedIds.has(block.id) || new Date(block.endAt) < now) {
      continue
    }
    const reason = block.done
      ? ('done' as const)
      : block.source === 'manual'
        ? ('manual' as const)
        : block.locked
          ? ('locked' as const)
          : new Date(block.startAt) < now
            ? ('past' as const)
            : ('not_replaced' as const)
    keptBlocks.push({
      id: block.id, taskId: block.taskId,
      startAt: block.startAt, endAt: block.endAt, reason,
    })
  }

  // placement validation against the accepted final state
  const newIds = new Set(newOrMoved.map((b) => b.id))
  const otherBlocks = [...finalBlocks.values()].filter((b) => !newIds.has(b.id))
  const windows = [...finalWindows.values()]
  for (const block of newOrMoved) {
    const start = new Date(block.startAt)
    const end = new Date(block.endAt)
    const label = `时间块 ${fmt(block.startAt)}`
    const task = finalTasks.get(block.taskId)
    if (!task) {
      errors.push(`${label} 引用的任务 ${block.taskId} 在本次变更后不存在`)
      continue
    }
    if (start < now) errors.push(`${label} 早于当前时间`)
    if (end > new Date(task.deadline)) {
      errors.push(`${label} 晚于任务「${task.title}」的截止时间`)
    }
    if (task.earliestStartAt && start < new Date(task.earliestStartAt)) {
      errors.push(`${label} 早于任务「${task.title}」的允许开始时间`)
    }
    for (const event of finalEvents.values()) {
      if (overlaps(start, end, new Date(event.startAt), new Date(event.endAt))) {
        errors.push(`${label} 与固定事件「${event.title}」重叠`)
      }
    }
    for (const other of otherBlocks) {
      if (overlaps(start, end, new Date(other.startAt), new Date(other.endAt))) {
        errors.push(`${label} 与已保留的时间块 ${other.id} 重叠`)
      }
    }
    for (const peer of newOrMoved) {
      if (
        peer.id < block.id &&
        overlaps(start, end, new Date(peer.startAt), new Date(peer.endAt))
      ) {
        errors.push(`${label} 与同批次时间块 ${peer.id} 重叠`)
      }
    }
    const startMin = start.getHours() * 60 + start.getMinutes()
    const sameDay = format(start, 'yyyy-MM-dd') === format(end, 'yyyy-MM-dd')
    const endMin = sameDay ? end.getHours() * 60 + end.getMinutes() : 24 * 60
    const dayWindows = windows.length
      ? windows
          .filter((w) => w.weekday === start.getDay())
          .map((w): [number, number] => [minutesOf(w.startTime), minutesOf(w.endTime)])
      : [[9 * 60, 17 * 60] as [number, number]]
    if (!dayWindows.some(([ws, we]) => ws <= startMin && endMin <= we)) {
      errors.push(`${label} 超出可用时间窗口`)
    }
  }

  // soft checks: daily cap + tasks still lacking scheduled time
  const capMinutes = state.settings.dailyMaxPlannedHours * 60
  const minutesByDay = new Map<string, number>()
  const scheduledByTask = new Map<string, number>()
  for (const block of finalBlocks.values()) {
    const length = Math.round(
      (new Date(block.endAt).getTime() - new Date(block.startAt).getTime()) / 60_000,
    )
    scheduledByTask.set(block.taskId, (scheduledByTask.get(block.taskId) ?? 0) + length)
    if (block.done || new Date(block.startAt) < now) continue
    const dayKey = format(new Date(block.startAt), 'yyyy-MM-dd')
    minutesByDay.set(dayKey, (minutesByDay.get(dayKey) ?? 0) + length)
  }
  for (const [dayKey, minutes] of [...minutesByDay.entries()].sort()) {
    if (minutes > capMinutes) {
      warnings.push(
        `${dayKey} 计划 ${(minutes / 60).toFixed(1)} 小时，超过每日上限 ${state.settings.dailyMaxPlannedHours} 小时`,
      )
    }
  }
  if (!useLocalScheduler) {
    for (const task of finalTasks.values()) {
      if (task.status !== 'active') continue
      const scheduled = scheduledByTask.get(task.id) ?? 0
      if (scheduled < task.estimatedMinutes) {
        warnings.push(`任务「${task.title}」尚有 ${task.estimatedMinutes - scheduled} 分钟未排入日程`)
      }
    }
  }

  return {
    changes,
    errors,
    warnings,
    effectiveIds: effective,
    keptBlocks,
    finalTasks,
    finalEvents,
    finalAvailability: finalWindows,
    finalBlocks,
    useLocalScheduler,
  }
}

export function changeSummary(scenario: Scenario): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const change of scenario.changes) {
    counts[change.kind] = (counts[change.kind] ?? 0) + 1
  }
  return counts
}
