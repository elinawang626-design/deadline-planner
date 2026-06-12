/**
 * Mock-mode task tracking: checklist, work logs, attachment metadata, AI
 * estimates and career cards in localStorage. Mirrors planner/track_api.py
 * semantics with two demo limitations: attachments keep metadata only (no
 * copy, no text extraction — the UI points users to backend mode) and the
 * estimate/career prompts omit attachment excerpts.
 */
import { listTasks, updateTask } from './tasks'
import { regenerateSchedule } from './schedule'
import type {
  ApplyEstimateResult,
  Attachment,
  CareerCard,
  ChecklistItem,
  Estimate,
  EstimatePromptResult,
  Task,
  TrackingSummary,
  WorkLog,
} from '../types'

interface TrackState {
  checklist: ChecklistItem[]
  worklogs: WorkLog[]
  attachments: Attachment[]
  estimates: Estimate[]
  careerCards: CareerCard[]
}

const STORAGE_KEY = 'deadline-planner-mock-track-v1'
const MOCK_LATENCY_MS = 60

const EMPTY: TrackState = {
  checklist: [],
  worklogs: [],
  attachments: [],
  estimates: [],
  careerCards: [],
}

function load(): TrackState {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return { ...EMPTY }
  try {
    return { ...EMPTY, ...(JSON.parse(raw) as TrackState) }
  } catch {
    return { ...EMPTY }
  }
}

function save(state: TrackState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), MOCK_LATENCY_MS))
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function requireTask(taskId: string): Promise<Task> {
  const task = (await listTasks()).find((t) => t.id === taskId)
  if (!task) throw new Error(`任务 ${taskId} 不存在`)
  return task
}

// ---- checklist ----

export async function listChecklist(taskId: string): Promise<ChecklistItem[]> {
  await requireTask(taskId)
  const items = load().checklist.filter((i) => i.taskId === taskId)
  return delay(items.sort((a, b) => a.position - b.position))
}

export async function createChecklistItem(
  taskId: string,
  title: string,
): Promise<ChecklistItem> {
  await requireTask(taskId)
  const state = load()
  const positions = state.checklist.filter((i) => i.taskId === taskId).map((i) => i.position)
  const item: ChecklistItem = {
    id: newId('chk'),
    taskId,
    title,
    completed: false,
    position: positions.length ? Math.max(...positions) + 1 : 0,
    createdAt: new Date().toISOString(),
  }
  save({ ...state, checklist: [...state.checklist, item] })
  return delay(item)
}

export async function updateChecklistItem(
  taskId: string,
  itemId: string,
  patch: Partial<Pick<ChecklistItem, 'title' | 'completed' | 'position'>>,
): Promise<ChecklistItem> {
  const state = load()
  const existing = state.checklist.find((i) => i.id === itemId && i.taskId === taskId)
  if (!existing) throw new Error('检查项不存在')
  const updated = { ...existing, ...patch }
  save({
    ...state,
    checklist: state.checklist.map((i) => (i.id === itemId ? updated : i)),
  })
  return delay(updated)
}

export async function deleteChecklistItem(taskId: string, itemId: string): Promise<void> {
  const state = load()
  save({
    ...state,
    checklist: state.checklist.filter((i) => !(i.id === itemId && i.taskId === taskId)),
  })
  return delay(undefined)
}

// ---- work logs ----

export async function listWorkLogs(taskId: string): Promise<WorkLog[]> {
  await requireTask(taskId)
  const logs = load().worklogs.filter((w) => w.taskId === taskId)
  return delay(logs.sort((a, b) => a.workedAt.localeCompare(b.workedAt)))
}

export async function createWorkLog(
  taskId: string,
  input: Omit<WorkLog, 'id' | 'taskId' | 'createdAt'>,
): Promise<WorkLog> {
  await requireTask(taskId)
  if (input.durationMinutes <= 0) throw new Error('投入分钟数必须为正整数')
  const state = load()
  const log: WorkLog = {
    ...input,
    id: newId('wlog'),
    taskId,
    createdAt: new Date().toISOString(),
  }
  save({ ...state, worklogs: [...state.worklogs, log] })
  return delay(log)
}

export async function updateWorkLog(
  taskId: string,
  logId: string,
  patch: Partial<Omit<WorkLog, 'id' | 'taskId' | 'createdAt'>>,
): Promise<WorkLog> {
  if (patch.durationMinutes !== undefined && patch.durationMinutes <= 0) {
    throw new Error('投入分钟数必须为正整数')
  }
  const state = load()
  const existing = state.worklogs.find((w) => w.id === logId && w.taskId === taskId)
  if (!existing) throw new Error('工作记录不存在')
  const updated = { ...existing, ...patch }
  save({ ...state, worklogs: state.worklogs.map((w) => (w.id === logId ? updated : w)) })
  return delay(updated)
}

export async function deleteWorkLog(taskId: string, logId: string): Promise<void> {
  const state = load()
  save({
    ...state,
    worklogs: state.worklogs.filter((w) => !(w.id === logId && w.taskId === taskId)),
  })
  return delay(undefined)
}

// ---- attachments (metadata only in mock mode) ----

export async function listAttachments(taskId: string): Promise<Attachment[]> {
  await requireTask(taskId)
  return delay(load().attachments.filter((a) => a.taskId === taskId))
}

export async function uploadAttachment(
  taskId: string,
  file: File,
  description?: string,
): Promise<Attachment> {
  await requireTask(taskId)
  const state = load()
  const attachment: Attachment = {
    id: newId('att'),
    taskId,
    displayName: file.name,
    storageMode: 'copy',
    mimeType: file.type || undefined,
    sizeBytes: file.size,
    description,
    extractionStatus: 'unsupported', // mock mode never parses files
    createdAt: new Date().toISOString(),
  }
  save({ ...state, attachments: [...state.attachments, attachment] })
  return delay(attachment)
}

export async function linkAttachment(
  taskId: string,
  path: string,
  description?: string,
): Promise<Attachment> {
  await requireTask(taskId)
  if (!path.startsWith('/') && !path.startsWith('~')) {
    throw new Error('link 模式需要绝对路径')
  }
  const state = load()
  const attachment: Attachment = {
    id: newId('att'),
    taskId,
    displayName: path.split('/').pop() || path,
    storageMode: 'link',
    originalPath: path,
    sizeBytes: 0,
    description,
    extractionStatus: 'unsupported',
    createdAt: new Date().toISOString(),
  }
  save({ ...state, attachments: [...state.attachments, attachment] })
  return delay(attachment)
}

export async function deleteAttachment(taskId: string, attachmentId: string): Promise<void> {
  const state = load()
  save({
    ...state,
    attachments: state.attachments.filter(
      (a) => !(a.id === attachmentId && a.taskId === taskId),
    ),
  })
  return delay(undefined)
}

// ---- strict JSON extraction (mirrors backend brace matching) ----

function matchBrace(text: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
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

function jsonCandidates(text: string, requiredKeys: string[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
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
    try {
      const data = JSON.parse(candidate) as Record<string, unknown>
      index = end + 1
      if (requiredKeys.some((key) => key in data)) found.push(data)
    } catch {
      index += 1
    }
  }
  return found
}

function asStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${label} 必须是字符串数组`)
  }
  return value as string[]
}

// ---- estimates ----

const ESTIMATE_KEYS = [
  'optimistic_minutes', 'likely_minutes', 'pessimistic_minutes', 'confidence',
  'breakdown', 'assumptions', 'risks', 'used_attachment_ids',
]

function parseEstimate(text: string, validAttachmentIds: Set<string>) {
  const candidates = jsonCandidates(text, ['optimistic_minutes', 'likely_minutes'])
  if (candidates.length === 0) throw new Error('回复中未找到估时 JSON')
  if (candidates.length > 1) throw new Error('回复中包含多个估时 JSON，请只保留一个')
  const data = candidates[0]
  const extra = Object.keys(data).filter((key) => !ESTIMATE_KEYS.includes(key))
  if (extra.length) throw new Error(`包含未知字段：${extra.join(', ')}`)
  const optimistic = data.optimistic_minutes
  const likely = data.likely_minutes
  const pessimistic = data.pessimistic_minutes
  for (const [label, value] of [
    ['optimistic_minutes', optimistic], ['likely_minutes', likely],
    ['pessimistic_minutes', pessimistic],
  ] as const) {
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new Error(`${label} 必须是正整数`)
    }
  }
  if (!((optimistic as number) <= (likely as number) && (likely as number) <= (pessimistic as number))) {
    throw new Error('必须满足 乐观 <= 最可能 <= 悲观')
  }
  if (!['low', 'medium', 'high'].includes(data.confidence as string)) {
    throw new Error('confidence 必须是 low/medium/high')
  }
  const breakdown = (Array.isArray(data.breakdown) ? data.breakdown : []) as Array<{
    step?: unknown
    minutes?: unknown
  }>
  for (const item of breakdown) {
    if (typeof item.step !== 'string' || !Number.isInteger(item.minutes) || (item.minutes as number) <= 0) {
      throw new Error('breakdown 每项必须是 {step: string, minutes: 正整数}')
    }
  }
  const usedIds = asStringArray(data.used_attachment_ids, 'used_attachment_ids')
  const unknownIds = usedIds.filter((id) => !validAttachmentIds.has(id))
  if (unknownIds.length) {
    throw new Error(`used_attachment_ids 引用了不存在的附件：${unknownIds.join(', ')}`)
  }
  return {
    optimisticMinutes: optimistic as number,
    likelyMinutes: likely as number,
    pessimisticMinutes: pessimistic as number,
    confidence: data.confidence as Estimate['confidence'],
    breakdown: breakdown as Estimate['breakdown'],
    assumptions: asStringArray(data.assumptions, 'assumptions'),
    risks: asStringArray(data.risks, 'risks'),
    sourceAttachmentIds: usedIds,
  }
}

export async function listEstimates(taskId: string): Promise<Estimate[]> {
  await requireTask(taskId)
  const estimates = load().estimates.filter((e) => e.taskId === taskId)
  return delay(estimates.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
}

export async function estimatePrompt(
  taskId: string,
  attachmentIds: string[],
): Promise<EstimatePromptResult> {
  const task = await requireTask(taskId)
  const state = load()
  const checklist = state.checklist.filter((i) => i.taskId === taskId)
  const worklogs = state.worklogs.filter((w) => w.taskId === taskId)
  const actual = worklogs.reduce((sum, w) => sum + w.durationMinutes, 0)
  const note =
    attachmentIds.length > 0
      ? '\n注意：Mock 模式不解析附件内容，估时请仅基于以下任务信息。附件解析需要后端模式。\n'
      : ''
  const prompt = `你是一个本地任务规划工具的估时助手。请阅读任务信息后输出一个估时 JSON。
${note}
## 待估时任务
${JSON.stringify(
    {
      title: task.title,
      description: task.description,
      type: task.type,
      deadline: task.deadline,
      current_estimated_minutes: task.estimatedMinutes,
      priority: task.priority,
    },
    null,
    2,
  )}

## 检查项
${JSON.stringify(checklist.map((c) => ({ title: c.title, completed: c.completed })), null, 2)}

## 已有工作记录（实际已投入 ${actual} 分钟）
${JSON.stringify(
    worklogs.map((w) => ({
      worked_at: w.workedAt,
      duration_minutes: w.durationMinutes,
      summary: w.summary,
    })),
    null,
    2,
  )}

## 输出规则
- 只输出一个 JSON 对象，字段：optimistic_minutes、likely_minutes、pessimistic_minutes（正整数，乐观 <= 最可能 <= 悲观）、confidence（low/medium/high）、breakdown（[{step, minutes}]）、assumptions、risks、used_attachment_ids。
- 不要发明字段。`
  return delay({ prompt, excerpts: [] })
}

export async function importEstimate(taskId: string, text: string): Promise<Estimate> {
  await requireTask(taskId)
  const state = load()
  const validIds = new Set(
    state.attachments.filter((a) => a.taskId === taskId).map((a) => a.id),
  )
  const parsed = parseEstimate(text, validIds)
  const estimate: Estimate = {
    ...parsed,
    id: newId('est'),
    taskId,
    createdAt: new Date().toISOString(),
    appliedAt: null,
  }
  save({ ...state, estimates: [...state.estimates, estimate] })
  return delay(estimate)
}

export async function applyEstimate(
  taskId: string,
  estimateId: string,
): Promise<ApplyEstimateResult> {
  await requireTask(taskId)
  const state = load()
  const estimate = state.estimates.find((e) => e.id === estimateId && e.taskId === taskId)
  if (!estimate) throw new Error('估时记录不存在')
  const applied = { ...estimate, appliedAt: new Date().toISOString() }
  save({
    ...state,
    estimates: state.estimates.map((e) => (e.id === estimateId ? applied : e)),
  })
  const task = await updateTask(taskId, { estimatedMinutes: estimate.likelyMinutes })
  const summary = await regenerateSchedule()
  return { task, estimate: applied, summary }
}

// ---- career card (one per task) ----

const CARD_KEYS = [
  'context', 'role', 'actions', 'challenges', 'outcomes', 'metrics', 'skills',
  'evidence_attachment_ids',
]

function parseCard(text: string, validAttachmentIds: Set<string>) {
  const candidates = jsonCandidates(text, ['context', 'role'])
  if (candidates.length === 0) throw new Error('回复中未找到素材卡 JSON')
  if (candidates.length > 1) throw new Error('回复中包含多个素材卡 JSON，请只保留一个')
  const data = candidates[0]
  const extra = Object.keys(data).filter((key) => !CARD_KEYS.includes(key))
  if (extra.length) throw new Error(`包含未知字段：${extra.join(', ')}`)
  if (typeof data.context !== 'string' || !data.context.trim()) {
    throw new Error('context 不能为空')
  }
  if (typeof data.role !== 'string' || !data.role.trim()) throw new Error('role 不能为空')
  const evidence = asStringArray(data.evidence_attachment_ids, 'evidence_attachment_ids')
  const unknownIds = evidence.filter((id) => !validAttachmentIds.has(id))
  if (unknownIds.length) {
    throw new Error(`evidence_attachment_ids 引用了不存在的附件：${unknownIds.join(', ')}`)
  }
  return {
    context: data.context,
    role: data.role,
    actions: asStringArray(data.actions, 'actions'),
    challenges: asStringArray(data.challenges, 'challenges'),
    outcomes: asStringArray(data.outcomes, 'outcomes'),
    metrics: asStringArray(data.metrics, 'metrics'),
    skills: asStringArray(data.skills, 'skills'),
    evidenceAttachmentIds: evidence,
  }
}

export async function getCareerCard(taskId: string): Promise<CareerCard | null> {
  await requireTask(taskId)
  return delay(load().careerCards.find((c) => c.taskId === taskId) ?? null)
}

export async function careerPrompt(
  taskId: string,
  confirmedMetrics: string,
): Promise<string> {
  const task = await requireTask(taskId)
  const state = load()
  const worklogs = state.worklogs.filter((w) => w.taskId === taskId)
  const prompt = `你是一个本地任务规划工具的职业素材整理助手。请基于以下事实输出一个素材卡 JSON（Mock 模式不解析附件）。

## 任务
${JSON.stringify({ title: task.title, description: task.description, type: task.type, status: task.status }, null, 2)}

## 工作记录
${JSON.stringify(
    worklogs.map((w) => ({
      worked_at: w.workedAt,
      duration_minutes: w.durationMinutes,
      summary: w.summary,
      challenge: w.challenge,
      result: w.result,
    })),
    null,
    2,
  )}

## 用户确认的指标
${confirmedMetrics.trim() || '（未提供；metrics 缺失数字一律写「待补充」，不得编造）'}

## 输出规则
- 只输出一个 JSON 对象，字段：context、role、actions、challenges、outcomes、metrics、skills、evidence_attachment_ids。
- 不要生成完整简历；metrics 不得虚构，缺失写「待补充」。
- 不要发明字段。`
  return delay(prompt)
}

export async function importCareerCard(taskId: string, text: string): Promise<CareerCard> {
  await requireTask(taskId)
  const state = load()
  const validIds = new Set(
    state.attachments.filter((a) => a.taskId === taskId).map((a) => a.id),
  )
  const parsed = parseCard(text, validIds)
  const existing = state.careerCards.find((c) => c.taskId === taskId)
  const now = new Date().toISOString()
  const card: CareerCard = {
    ...parsed,
    id: `career-${taskId}`,
    taskId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  save({
    ...state,
    careerCards: [...state.careerCards.filter((c) => c.taskId !== taskId), card],
  })
  return delay(card)
}

export async function patchCareerCard(
  taskId: string,
  patch: Partial<Pick<CareerCard, 'context' | 'role' | 'actions' | 'challenges' | 'outcomes' | 'metrics' | 'skills'>>,
): Promise<CareerCard> {
  const state = load()
  const existing = state.careerCards.find((c) => c.taskId === taskId)
  if (!existing) throw new Error('该任务还没有职业素材卡')
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() }
  save({
    ...state,
    careerCards: state.careerCards.map((c) => (c.taskId === taskId ? updated : c)),
  })
  return delay(updated)
}

export async function exportCareerCardMarkdown(taskId: string): Promise<string> {
  const task = await requireTask(taskId)
  const card = load().careerCards.find((c) => c.taskId === taskId)
  if (!card) throw new Error('该任务还没有职业素材卡')
  const bullets = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : '- （无）'
  return delay(`# 职业素材卡：${task.title}

## 背景
${card.context}

## 个人角色
${card.role}

## 关键行动
${bullets(card.actions)}

## 难点
${bullets(card.challenges)}

## 解决方法与结果
${bullets(card.outcomes)}

## 可量化指标
${bullets(card.metrics)}

## 使用技能
${bullets(card.skills)}

---
生成于 ${card.updatedAt}
`)
}

// ---- aggregated summary ----

export async function trackingSummary(): Promise<TrackingSummary[]> {
  const tasks = await listTasks()
  const state = load()
  return delay(
    tasks.map((task) => {
      const items = state.checklist.filter((c) => c.taskId === task.id)
      return {
        taskId: task.id,
        checklistDone: items.filter((c) => c.completed).length,
        checklistTotal: items.length,
        actualMinutes: state.worklogs
          .filter((w) => w.taskId === task.id)
          .reduce((sum, w) => sum + w.durationMinutes, 0),
        attachmentCount: state.attachments.filter((a) => a.taskId === task.id).length,
      }
    }),
  )
}
