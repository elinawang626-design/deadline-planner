/**
 * Mock data mode: a localStorage-backed store plus an in-browser port of the
 * backend's deterministic scheduler, so the whole app works with no backend.
 * TODO(backend): keep this file for demos; flip VITE_USE_MOCK=false to switch
 * to the real HTTP API.
 */
import { addDays, addHours, format, startOfDay } from 'date-fns'
import {
  buildPrompt,
  buildScenario,
  changeSummary,
  extractPlan,
  stateVersion,
  type PlanState,
} from './aiPlan'
import { MAX_HORIZON_DAYS, scheduleEngine, type EngineTask } from './mockEngine'
import type {
  AvailabilityWindow,
  FixedEvent,
  PlanCreate,
  PlanCreateResult,
  PlanImportResult,
  PlanMode,
  PlanPreview,
  ScheduleSummary,
  ScheduleWarning,
  ScheduledBlock,
  Settings,
  Task,
  TaskScheduleStat,
  TaskStatus,
} from '../types'

interface MockState {
  tasks: Task[]
  blocks: ScheduledBlock[]
  availability: AvailabilityWindow[]
  fixedEvents: FixedEvent[]
  settings: Settings
}

const STORAGE_KEY = 'deadline-planner-mock-v1'
const MOCK_LATENCY_MS = 60
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

function seed(): MockState {
  const now = new Date()
  const tomorrow10 = addHours(startOfDay(addDays(now, 1)), 10)
  return {
    tasks: [
      {
        id: 'task-demo-report',
        title: '季度报告',
        type: 'assignment',
        deadline: addHours(startOfDay(addDays(now, 5)), 18).toISOString(),
        estimatedMinutes: 180,
        priority: 'high',
        splittable: true,
        status: 'active',
        createdAt: now.toISOString(),
      },
      {
        id: 'task-demo-slides',
        title: '评审幻灯片',
        type: 'project',
        deadline: addHours(startOfDay(addDays(now, 7)), 12).toISOString(),
        estimatedMinutes: 120,
        priority: 'medium',
        splittable: true,
        status: 'active',
        createdAt: now.toISOString(),
      },
    ],
    blocks: [],
    availability: [],
    fixedEvents: [
      {
        id: 'event-demo-dentist',
        title: '牙医预约',
        startAt: tomorrow10.toISOString(),
        endAt: addHours(tomorrow10, 1).toISOString(),
      },
    ],
    settings: { dailyMaxPlannedHours: 6 },
  }
}

function migrate(state: MockState): MockState {
  // legacy stored source 'auto' becomes 'local_auto'
  return {
    ...state,
    blocks: state.blocks.map((b) =>
      (b.source as string) === 'auto' ? { ...b, source: 'local_auto' } : b,
    ),
  }
}

function load(): MockState {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const state = seed()
    save(state)
    return state
  }
  try {
    return migrate(JSON.parse(raw) as MockState)
  } catch {
    const state = seed()
    save(state)
    return state
  }
}

function save(state: MockState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), MOCK_LATENCY_MS))
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ---- tasks ----

export type TaskCreate = Omit<Task, 'id' | 'createdAt' | 'status'> & { status?: TaskStatus }

export async function listTasks(): Promise<Task[]> {
  return delay([...load().tasks])
}

export async function createTask(input: TaskCreate): Promise<Task> {
  const state = load()
  const task: Task = {
    ...input,
    id: newId('task'),
    status: input.status ?? 'active',
    createdAt: new Date().toISOString(),
  }
  save({ ...state, tasks: [...state.tasks, task] })
  return delay(task)
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<Task> {
  const state = load()
  const existing = state.tasks.find((t) => t.id === id)
  if (!existing) throw new Error(`任务 ${id} 不存在`)
  const updated: Task = { ...existing, ...patch, id }
  save({ ...state, tasks: state.tasks.map((t) => (t.id === id ? updated : t)) })
  return delay(updated)
}

export async function deleteTask(id: string): Promise<void> {
  const state = load()
  save({
    ...state,
    tasks: state.tasks.filter((t) => t.id !== id),
    blocks: state.blocks.filter((b) => b.taskId !== id),
  })
  return delay(undefined)
}

// ---- blocks ----

export async function listBlocks(start?: string, end?: string): Promise<ScheduledBlock[]> {
  const blocks = load()
    .blocks.filter((b) => (!end || b.startAt < end) && (!start || b.endAt > start))
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
  return delay(blocks)
}

export async function updateBlock(
  id: string,
  patch: Partial<ScheduledBlock>,
): Promise<ScheduledBlock> {
  const state = load()
  const existing = state.blocks.find((b) => b.id === id)
  if (!existing) throw new Error(`时间块 ${id} 不存在`)
  // a user-moved/resized AI or auto block becomes a manual block
  const timeChanged =
    (patch.startAt !== undefined && patch.startAt !== existing.startAt) ||
    (patch.endAt !== undefined && patch.endAt !== existing.endAt)
  if (timeChanged && patch.source === undefined) {
    patch = { ...patch, source: 'manual' }
  }
  const updated: ScheduledBlock = { ...existing, ...patch, id }
  save({ ...state, blocks: state.blocks.map((b) => (b.id === id ? updated : b)) })
  return delay(updated)
}

export async function deleteBlock(id: string): Promise<void> {
  const state = load()
  save({ ...state, blocks: state.blocks.filter((b) => b.id !== id) })
  return delay(undefined)
}

export async function listFixedEvents(): Promise<FixedEvent[]> {
  return delay([...load().fixedEvents])
}

// ---- availability & settings ----

export async function listAvailability(): Promise<AvailabilityWindow[]> {
  const windows = [...load().availability].sort(
    (a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime),
  )
  return delay(windows)
}

export async function createAvailability(
  input: Omit<AvailabilityWindow, 'id'>,
): Promise<AvailabilityWindow> {
  const state = load()
  const window: AvailabilityWindow = { ...input, id: newId('window') }
  save({ ...state, availability: [...state.availability, window] })
  return delay(window)
}

export async function updateAvailability(
  id: string,
  patch: Partial<AvailabilityWindow>,
): Promise<AvailabilityWindow> {
  const state = load()
  const existing = state.availability.find((w) => w.id === id)
  if (!existing) throw new Error(`可用时间窗口 ${id} 不存在`)
  const updated: AvailabilityWindow = { ...existing, ...patch, id }
  save({
    ...state,
    availability: state.availability.map((w) => (w.id === id ? updated : w)),
  })
  return delay(updated)
}

export async function deleteAvailability(id: string): Promise<void> {
  const state = load()
  save({ ...state, availability: state.availability.filter((w) => w.id !== id) })
  return delay(undefined)
}

export async function getSettings(): Promise<Settings> {
  return delay({ ...load().settings })
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const state = load()
  save({ ...state, settings })
  return delay(settings)
}

// ---- AI plan import (same parse / preview / import rules as the backend) ----

function toPlanState(state: MockState): PlanState {
  return {
    tasks: state.tasks,
    blocks: state.blocks,
    availability: state.availability,
    fixedEvents: state.fixedEvents,
    settings: state.settings,
  }
}

export async function generatePlanPromptMock(
  mode: PlanMode,
  requirements: string,
): Promise<string> {
  return delay(buildPrompt(mode, requirements, toPlanState(load()), new Date()))
}

export async function validatePlanOutputMock(
  text: string,
  mode: PlanMode,
): Promise<PlanPreview> {
  const state = toPlanState(load())
  const { plan, errors } = extractPlan(text)
  if (!plan) {
    return delay({
      ok: false,
      errors,
      warnings: [],
      previewVersion: '',
      summary: {},
      changes: [],
      keptBlocks: [],
      useLocalScheduler: false,
    })
  }
  const scenario = buildScenario(state, plan, mode, new Date())
  return delay({
    ok: scenario.errors.length === 0,
    errors: scenario.errors,
    warnings: scenario.warnings,
    previewVersion: stateVersion(state),
    summary: changeSummary(scenario),
    changes: scenario.changes,
    keptBlocks: scenario.keptBlocks,
    useLocalScheduler: scenario.useLocalScheduler,
  })
}

export async function importPlanMock(
  text: string,
  mode: PlanMode,
  previewVersion: string,
  acceptedChangeIds?: string[],
): Promise<PlanImportResult> {
  const mockState = load()
  const state = toPlanState(mockState)
  if (stateVersion(state) !== previewVersion) {
    throw new Error('数据在预览后已发生变化，请重新校验并查看新预览')
  }
  const { plan, errors } = extractPlan(text)
  if (!plan) throw new Error(errors.join('；'))
  const accepted = acceptedChangeIds === undefined ? undefined : new Set(acceptedChangeIds)
  const scenario = buildScenario(state, plan, mode, new Date(), accepted)
  if (scenario.errors.length) throw new Error(scenario.errors.join('；'))

  // atomic in mock terms: a single save() of the accepted final state
  let nextState: MockState = {
    ...mockState,
    tasks: [...scenario.finalTasks.values()],
    blocks: [...scenario.finalBlocks.values()],
    availability: [...scenario.finalAvailability.values()],
    fixedEvents: [...scenario.finalEvents.values()],
  }
  let scheduleSummary: ScheduleSummary | undefined
  if (scenario.useLocalScheduler) {
    const result = runScheduler(nextState)
    nextState = result.state
    scheduleSummary = result.summary
  }
  save(nextState)
  return delay({
    applied: scenario.effectiveIds.size,
    rejected: scenario.changes.length - scenario.effectiveIds.size,
    scheduleSummary,
  })
}

// ---- deterministic scheduler (engine port shared with the backend) ----

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd
}

function blockMinutes(block: ScheduledBlock): number {
  return Math.round(
    (new Date(block.endAt).getTime() - new Date(block.startAt).getTime()) / 60_000,
  )
}

function runScheduler(state: MockState): { state: MockState; summary: ScheduleSummary } {
  const now = new Date()
  const capMinutes = state.settings.dailyMaxPlannedHours * 60

  // replace only future, unlocked, locally auto-generated, not-done blocks
  const removedIds = new Set(
    state.blocks
      .filter(
        (b) => b.source === 'local_auto' && !b.locked && !b.done && new Date(b.startAt) >= now,
      )
      .map((b) => b.id),
  )
  const kept = state.blocks.filter((b) => !removedIds.has(b.id))

  // fixed events and kept blocks occupy time; only future not-done task
  // blocks count toward the daily load cap
  const busy: Array<[Date, Date]> = [
    ...state.fixedEvents.map((e): [Date, Date] => [new Date(e.startAt), new Date(e.endAt)]),
    ...kept.map((b): [Date, Date] => [new Date(b.startAt), new Date(b.endAt)]),
  ]
  const dayLoad = new Map<string, number>()
  for (const b of kept) {
    if (b.done || new Date(b.startAt) < now) continue
    const key = format(new Date(b.startAt), 'yyyy-MM-dd')
    dayLoad.set(key, (dayLoad.get(key) ?? 0) + blockMinutes(b))
  }
  const plannedByTask = new Map<string, number>()
  for (const b of kept) {
    plannedByTask.set(b.taskId, (plannedByTask.get(b.taskId) ?? 0) + blockMinutes(b))
  }

  const active = state.tasks.filter((t) => t.status === 'active')
  const titles = new Map(state.tasks.map((t) => [t.id, t.title]))
  // Tasks without a deadline are kept but never auto-scheduled.
  const schedulable = active.filter((t) => t.deadline)
  const engineTasks: EngineTask[] = schedulable.map((t) => ({
    id: t.id,
    deadline: new Date(t.deadline!),
    remainingMinutes: Math.max(0, t.estimatedMinutes - (plannedByTask.get(t.id) ?? 0)),
    priorityRank: PRIORITY_RANK[t.priority],
    splittable: t.splittable,
    earliestStartAt: t.earliestStartAt ? new Date(t.earliestStartAt) : undefined,
    minBlockMinutes: t.minBlockMinutes,
    maxBlockMinutes: t.maxBlockMinutes,
    preferredWindows: (t.preferredWindows ?? []).map((w) => ({
      weekday: w.weekday,
      startMin: minutesOf(w.startTime),
      endMin: minutesOf(w.endTime),
    })),
  }))

  const windowsByWeekday = new Map<number, Array<[number, number]>>()
  for (const w of state.availability) {
    const list = windowsByWeekday.get(w.weekday) ?? []
    list.push([minutesOf(w.startTime), minutesOf(w.endTime)])
    windowsByWeekday.set(w.weekday, list)
  }

  const result = scheduleEngine({
    now,
    tasks: engineTasks,
    windowsByWeekday,
    busy,
    initialDayLoad: dayLoad,
    dailyMaxMinutes: capMinutes,
  })

  const warnings: ScheduleWarning[] = active
    .filter((t) => !t.deadline)
    .map((t) => ({
      type: 'missing_deadline' as const,
      taskId: t.id,
      message: `任务「${t.title}」没有截止日期，未参与自动排程`,
    }))
  const unscheduled: string[] = []
  const overloadedDays = new Set<string>()
  for (const w of result.warnings) {
    const title = titles.get(w.taskId) ?? w.taskId
    if (w.kind === 'beyond_horizon') {
      warnings.push({
        type: 'deadline_unreachable',
        taskId: w.taskId,
        message: `任务「${title}」截止日超出 ${MAX_HORIZON_DAYS} 天调度范围，仅安排范围内时段`,
      })
    } else if (w.kind === 'partial') {
      warnings.push({
        type: 'insufficient_time',
        taskId: w.taskId,
        message: `任务「${title}」只安排了 ${w.placedMinutes}/${w.requestedMinutes} 分钟，截止前即使超载也没有更多可用时间`,
      })
    } else if (w.kind === 'no_slot') {
      unscheduled.push(w.taskId)
      warnings.push({
        type: 'deadline_unreachable',
        taskId: w.taskId,
        message: `任务「${title}」在截止前没有可用空档`,
      })
    } else if (w.kind === 'non_splittable') {
      unscheduled.push(w.taskId)
      warnings.push({
        type: 'insufficient_time',
        taskId: w.taskId,
        message: `任务「${title}」不可拆分，且截止前找不到足够长的连续空档`,
      })
    } else if (w.kind === 'overload' && w.day) {
      overloadedDays.add(w.day)
      warnings.push({
        type: 'overloaded_day',
        taskId: w.taskId,
        message: `为按期完成「${title}」，${w.day} 在每日上限 ${state.settings.dailyMaxPlannedHours} 小时之外额外安排 ${w.extraMinutes} 分钟`,
      })
    }
  }

  const created: ScheduledBlock[] = result.blocks.map((b) => ({
    id: newId('block'),
    taskId: b.taskId,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
    locked: false,
    source: 'local_auto',
    done: false,
  }))
  const allBlocks = [...kept, ...created].sort((a, b) => a.startAt.localeCompare(b.startAt))

  // days overloaded purely by manual/locked blocks
  const minutesByDay = new Map<string, number>()
  for (const b of allBlocks) {
    if (b.done) continue
    const key = format(new Date(b.startAt), 'yyyy-MM-dd')
    minutesByDay.set(key, (minutesByDay.get(key) ?? 0) + blockMinutes(b))
  }
  for (const [day, minutes] of [...minutesByDay.entries()].sort()) {
    if (minutes > capMinutes && !overloadedDays.has(day)) {
      warnings.push({
        type: 'overloaded_day',
        message: `${day} 计划 ${(minutes / 60).toFixed(1)} 小时，超过每日上限 ${state.settings.dailyMaxPlannedHours} 小时`,
      })
    }
  }

  // overlapping manual/locked blocks
  const pinned = kept.filter((b) => b.locked || b.source === 'manual')
  for (let i = 0; i < pinned.length; i++) {
    for (let j = i + 1; j < pinned.length; j++) {
      const a = pinned[i]
      const b = pinned[j]
      if (overlaps(new Date(a.startAt), new Date(a.endAt), new Date(b.startAt), new Date(b.endAt))) {
        warnings.push({
          type: 'overlap',
          message: `两个手动/锁定块重叠：${format(new Date(a.startAt), 'MM-dd HH:mm')} 与 ${format(new Date(b.startAt), 'MM-dd HH:mm')}`,
        })
      }
    }
  }

  const placedByTask = new Map(result.stats.map((s) => [s.taskId, s]))
  let totalUnscheduled = 0
  const taskStats: TaskScheduleStat[] = active.map((t) => {
    const planned = plannedByTask.get(t.id) ?? 0
    const stat = placedByTask.get(t.id)
    const placed = stat?.placedMinutes ?? 0
    const remaining = stat
      ? stat.remainingMinutes
      : Math.max(0, t.estimatedMinutes - planned)
    totalUnscheduled += remaining
    return {
      taskId: t.id,
      scheduledMinutes: planned + placed,
      unscheduledMinutes: remaining,
    }
  })

  return {
    state: { ...state, blocks: allBlocks },
    summary: {
      createdBlocks: created.length,
      removedBlocks: removedIds.size,
      unscheduledTaskIds: unscheduled,
      totalUnscheduledMinutes: totalUnscheduled,
      taskStats,
      warnings,
    },
  }
}

export async function regenerateSchedule(): Promise<ScheduleSummary> {
  const { state, summary } = runScheduler(load())
  save(state)
  return delay(summary)
}

// ---- manual plans ----

function manualPlanWarnings(
  state: MockState,
  task: Task,
  block: ScheduledBlock,
): ScheduleWarning[] {
  const warnings: ScheduleWarning[] = []
  const start = new Date(block.startAt)
  const end = new Date(block.endAt)

  for (const event of state.fixedEvents) {
    if (overlaps(start, end, new Date(event.startAt), new Date(event.endAt))) {
      warnings.push({
        type: 'overlap',
        taskId: task.id,
        message: `手动计划与固定事件「${event.title}」重叠`,
      })
    }
  }
  for (const other of state.blocks) {
    if (other.id === block.id) continue
    if (overlaps(start, end, new Date(other.startAt), new Date(other.endAt))) {
      warnings.push({
        type: 'overlap',
        taskId: task.id,
        message: `手动计划与已有时间块重叠：${format(new Date(other.startAt), 'MM-dd HH:mm')}–${format(new Date(other.endAt), 'HH:mm')}`,
      })
    }
  }

  const startMin = start.getHours() * 60 + start.getMinutes()
  const sameDay = format(start, 'yyyy-MM-dd') === format(end, 'yyyy-MM-dd')
  const endMin = sameDay ? end.getHours() * 60 + end.getMinutes() : 24 * 60
  const dayWindows = state.availability.length
    ? state.availability
        .filter((w) => w.weekday === start.getDay())
        .map((w): [number, number] => [minutesOf(w.startTime), minutesOf(w.endTime)])
    : [[9 * 60, 17 * 60] as [number, number]]
  if (!dayWindows.some(([ws, we]) => ws <= startMin && endMin <= we)) {
    warnings.push({
      type: 'outside_availability',
      taskId: task.id,
      message: '手动计划超出当天的可用时间窗口',
    })
  }

  if (task.deadline && end > new Date(task.deadline)) {
    warnings.push({
      type: 'past_deadline',
      taskId: task.id,
      message: `手动计划晚于任务「${task.title}」的截止时间`,
    })
  }

  const dayKey = format(start, 'yyyy-MM-dd')
  const dayMinutes =
    state.blocks
      .filter(
        (b) =>
          b.id !== block.id && !b.done && format(new Date(b.startAt), 'yyyy-MM-dd') === dayKey,
      )
      .reduce((sum, b) => sum + blockMinutes(b), 0) + blockMinutes(block)
  const capMinutes = state.settings.dailyMaxPlannedHours * 60
  if (dayMinutes > capMinutes) {
    warnings.push({
      type: 'overloaded_day',
      taskId: task.id,
      message: `${dayKey} 计划 ${(dayMinutes / 60).toFixed(1)} 小时，超过每日上限 ${state.settings.dailyMaxPlannedHours} 小时`,
    })
  }
  return warnings
}

export async function createPlan(input: PlanCreate): Promise<PlanCreateResult> {
  const state = load()
  const start = new Date(input.startAt)
  const end = new Date(input.endAt)
  if (!(start < end)) throw new Error('结束时间必须晚于开始时间')
  if (!input.taskId === !input.newTask) {
    throw new Error('请选择现有任务或填写新任务（二选一）')
  }

  let task: Task
  let tasks = state.tasks
  if (input.taskId) {
    const existing = tasks.find((t) => t.id === input.taskId)
    if (!existing) throw new Error(`任务 ${input.taskId} 不存在`)
    task = existing
  } else {
    task = {
      ...input.newTask!,
      id: newId('task'),
      status: input.newTask!.status ?? 'active',
      createdAt: new Date().toISOString(),
    }
    tasks = [...tasks, task]
  }

  const block: ScheduledBlock = {
    id: newId('block'),
    taskId: task.id,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    locked: true,
    source: 'manual',
    done: false,
    notes: input.notes,
  }
  const withPlan: MockState = { ...state, tasks, blocks: [...state.blocks, block] }
  const warnings = manualPlanWarnings(withPlan, task, block)
  const { state: nextState, summary } = runScheduler(withPlan)
  save(nextState)
  return delay({ task, block, warnings, summary })
}
