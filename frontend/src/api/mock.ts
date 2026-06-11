/**
 * Mock data mode: a localStorage-backed store plus an in-browser port of the
 * backend's deterministic scheduler, so the whole app works with no backend.
 * TODO(backend): keep this file for demos; flip VITE_USE_MOCK=false to switch
 * to the real HTTP API.
 */
import { addDays, addHours, format, startOfDay } from 'date-fns'
import type {
  AvailabilityWindow,
  FixedEvent,
  ScheduleSummary,
  ScheduleWarning,
  ScheduledBlock,
  Settings,
  Task,
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
const HORIZON_DAYS = 14
const DEFAULT_WINDOW = { startTime: '09:00', endTime: '17:00' }
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

function load(): MockState {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const state = seed()
    save(state)
    return state
  }
  try {
    return JSON.parse(raw) as MockState
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

// ---- AI import ----

/** Shape produced by the manual LLM workflow (mirrors the backend ParsedTask). */
export interface ParsedLlmTask {
  id?: string
  title: string
  deadline: string
  estimated_hours: number
  priority: 'high' | 'medium' | 'low'
  earliest_start_at?: string
}

export async function importParsedTasks(items: ParsedLlmTask[]): Promise<number> {
  const state = load()
  let tasks = state.tasks
  for (const item of items) {
    const id = item.id ?? newId('task')
    const existing = tasks.find((t) => t.id === id)
    const merged: Task = {
      id,
      title: item.title,
      type: existing?.type ?? 'other',
      deadline: item.deadline,
      estimatedMinutes: Math.round(item.estimated_hours * 60),
      earliestStartAt: item.earliest_start_at,
      priority: item.priority,
      splittable: existing?.splittable ?? true,
      status: existing?.status ?? 'active',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    tasks = existing
      ? tasks.map((t) => (t.id === id ? { ...t, ...merged } : t))
      : [...tasks, merged]
  }
  save({ ...state, tasks })
  return delay(items.length)
}

// ---- deterministic scheduler (port of the Python backend) ----

function ceilToHour(date: Date): Date {
  const copy = new Date(date)
  if (copy.getMinutes() || copy.getSeconds() || copy.getMilliseconds()) {
    copy.setMinutes(0, 0, 0)
    return addHours(copy, 1)
  }
  return copy
}

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd
}

export async function regenerateSchedule(): Promise<ScheduleSummary> {
  const state = load()
  const now = new Date()
  const horizonStart = ceilToHour(now)
  const horizonEnd = addDays(now, HORIZON_DAYS)

  // replace only future, unlocked, auto-generated, not-done blocks
  const removedIds = new Set(
    state.blocks
      .filter((b) => b.source === 'auto' && !b.locked && !b.done && new Date(b.startAt) >= now)
      .map((b) => b.id),
  )
  const kept = state.blocks.filter((b) => !removedIds.has(b.id))

  const busy: Array<[Date, Date]> = [
    ...state.fixedEvents.map((e): [Date, Date] => [new Date(e.startAt), new Date(e.endAt)]),
    ...kept.map((b): [Date, Date] => [new Date(b.startAt), new Date(b.endAt)]),
  ]

  // one-hour free slots from availability (default 09:00-17:00 when none)
  const slotSet = new Map<number, Date>()
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const day = startOfDay(addDays(now, i))
    const windows = state.availability.filter((w) => w.weekday === day.getDay())
    const effective = windows.length ? windows : [DEFAULT_WINDOW]
    for (const w of effective) {
      const endMin = minutesOf(w.endTime)
      for (let h = Math.ceil(minutesOf(w.startTime) / 60); (h + 1) * 60 <= endMin; h++) {
        const slotStart = addHours(day, h)
        const slotEnd = addHours(slotStart, 1)
        if (slotStart < horizonStart || slotEnd > horizonEnd) continue
        if (busy.some(([s, e]) => overlaps(slotStart, slotEnd, s, e))) continue
        slotSet.set(slotStart.getTime(), slotStart)
      }
    }
  }
  const free = [...slotSet.values()].sort((a, b) => a.getTime() - b.getTime())

  const warnings: ScheduleWarning[] = []
  const unscheduled: string[] = []
  const created: ScheduledBlock[] = []
  const used = new Set<number>()

  const active = [...state.tasks]
    .filter((t) => t.status === 'active')
    .sort(
      (a, b) =>
        a.deadline.localeCompare(b.deadline) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.id.localeCompare(b.id),
    )

  for (const task of active) {
    if (!task.estimatedMinutes) {
      warnings.push({
        type: 'missing_estimate',
        taskId: task.id,
        message: `任务「${task.title}」缺少预计时长，已跳过`,
      })
      unscheduled.push(task.id)
      continue
    }
    const deadline = new Date(task.deadline)
    if (deadline > horizonEnd) {
      warnings.push({
        type: 'deadline_unreachable',
        taskId: task.id,
        message: `任务「${task.title}」截止日超出 ${HORIZON_DAYS} 天调度范围，仅安排范围内时段`,
      })
    }

    const plannedMinutes = kept
      .filter((b) => b.taskId === task.id)
      .reduce(
        (sum, b) => sum + (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60_000,
        0,
      )
    const neededHours = Math.ceil(Math.max(0, task.estimatedMinutes - plannedMinutes) / 60)
    if (neededHours === 0) continue

    const earliest = task.earliestStartAt ? new Date(task.earliestStartAt) : null
    const eligible: number[] = []
    free.forEach((slot, index) => {
      if (used.has(index)) return
      if (earliest && slot < earliest) return
      if (addHours(slot, 1) > deadline) return
      eligible.push(index)
    })

    const matchesPreferred = (slot: Date): boolean =>
      (task.preferredWindows ?? []).some(
        (w) =>
          w.weekday === slot.getDay() &&
          slot.getHours() * 60 >= minutesOf(w.startTime) &&
          (slot.getHours() + 1) * 60 <= minutesOf(w.endTime),
      )

    let picks: number[] = []
    if (!task.splittable && neededHours > 1) {
      // non-splittable tasks need one contiguous run of hours
      for (let i = 0; i + neededHours <= eligible.length; i++) {
        const run = eligible.slice(i, i + neededHours)
        const contiguous = run.every(
          (idx, k) => k === 0 || free[idx].getTime() - free[run[k - 1]].getTime() === 3_600_000,
        )
        if (contiguous) {
          picks = run
          break
        }
      }
      if (!picks.length) {
        warnings.push({
          type: 'insufficient_time',
          taskId: task.id,
          message: `任务「${task.title}」不可拆分，且截止前找不到连续 ${neededHours} 小时空档`,
        })
        unscheduled.push(task.id)
        continue
      }
    } else {
      let ordered = eligible
      if (task.preferredWindows?.length) {
        const preferred = eligible.filter((i) => matchesPreferred(free[i]))
        const rest = eligible.filter((i) => !matchesPreferred(free[i]))
        ordered = [...preferred, ...rest]
      }
      picks = ordered.slice(0, neededHours)
    }

    if (!picks.length) {
      warnings.push({
        type: 'deadline_unreachable',
        taskId: task.id,
        message: `任务「${task.title}」在截止前没有可用空档`,
      })
      unscheduled.push(task.id)
      continue
    }
    if (picks.length < neededHours) {
      warnings.push({
        type: 'insufficient_time',
        taskId: task.id,
        message: `任务「${task.title}」只安排了 ${picks.length}/${neededHours} 小时`,
      })
    }
    for (const index of picks) {
      used.add(index)
      created.push({
        id: newId('block'),
        taskId: task.id,
        startAt: free[index].toISOString(),
        endAt: addHours(free[index], 1).toISOString(),
        locked: false,
        source: 'auto',
        done: false,
      })
    }
  }

  const allBlocks = [...kept, ...created].sort((a, b) => a.startAt.localeCompare(b.startAt))

  // overloaded days
  const hoursByDay = new Map<string, number>()
  for (const b of allBlocks) {
    const key = format(new Date(b.startAt), 'yyyy-MM-dd')
    const hours = (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 3_600_000
    hoursByDay.set(key, (hoursByDay.get(key) ?? 0) + hours)
  }
  for (const [day, hours] of hoursByDay) {
    if (hours > state.settings.dailyMaxPlannedHours) {
      warnings.push({
        type: 'overloaded_day',
        message: `${day} 计划 ${hours.toFixed(1)} 小时，超过每日上限 ${state.settings.dailyMaxPlannedHours} 小时`,
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

  save({ ...state, blocks: allBlocks })
  return delay({
    createdBlocks: created.length,
    removedBlocks: removedIds.size,
    unscheduledTaskIds: unscheduled,
    warnings,
  })
}
