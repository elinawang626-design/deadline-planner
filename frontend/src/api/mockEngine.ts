/**
 * In-browser port of the backend's shared scheduling engine
 * (planner/engine.py) so mock mode follows exactly the same rules:
 * 15-minute slots, a hard daily cap in phase 1, balanced and moderately
 * front-loaded placement, and minimal spread-out overload in phase 2.
 */
import { addDays, addMinutes, differenceInMinutes, format, startOfDay } from 'date-fns'

export const SLOT_MINUTES = 15
export const DEFAULT_CHUNK_MINUTES = 60
export const MAX_HORIZON_DAYS = 90

const BALANCE_WEIGHT = 100
const PREFERRED_BONUS = 15
const CHUNK_BONUS = 5
const EARLY_DAY_PENALTY = 2
const FALLBACK_DAY_MINUTES = 8 * 60

const DEFAULT_WINDOW: [number, number] = [9 * 60, 17 * 60]

export interface EnginePreferredWindow {
  weekday: number // JS getDay(): 0 = Sunday
  startMin: number
  endMin: number
}

export interface EngineTask {
  id: string
  deadline: Date
  remainingMinutes: number
  priorityRank: number
  splittable: boolean
  earliestStartAt?: Date
  minBlockMinutes?: number
  maxBlockMinutes?: number
  preferredWindows: EnginePreferredWindow[]
}

export interface EngineBlock {
  taskId: string
  startAt: Date
  endAt: Date
  overloaded: boolean
}

export type EngineWarningKind =
  | 'beyond_horizon'
  | 'partial'
  | 'no_slot'
  | 'non_splittable'
  | 'overload'

export interface EngineWarning {
  kind: EngineWarningKind
  taskId: string
  day?: string // 'yyyy-MM-dd'
  requestedMinutes?: number
  placedMinutes?: number
  capMinutes?: number
  extraMinutes?: number
}

export interface EngineTaskStat {
  taskId: string
  placedMinutes: number
  remainingMinutes: number
}

export interface EngineResult {
  blocks: EngineBlock[]
  warnings: EngineWarning[]
  stats: EngineTaskStat[]
}

interface Interval {
  start: Date
  end: Date
}

interface Candidate {
  score: number[]
  dayIndex: number
  dayKey: string
  intervalIndex: number
  start: Date
  chunk: number
}

export function snapUp(value: Date): Date {
  const snapped = new Date(value)
  snapped.setSeconds(0, 0)
  snapped.setMinutes(snapped.getMinutes() - (snapped.getMinutes() % SLOT_MINUTES))
  return snapped.getTime() === value.getTime()
    ? snapped
    : addMinutes(snapped, SLOT_MINUTES)
}

function dayKeyOf(value: Date): string {
  return format(value, 'yyyy-MM-dd')
}

function subtractBusy(span: Interval, busy: Interval[]): Interval[] {
  let pieces: Interval[] = [span]
  for (const b of busy) {
    const next: Interval[] = []
    for (const p of pieces) {
      if (b.end <= p.start || p.end <= b.start) {
        next.push(p)
        continue
      }
      if (p.start < b.start) next.push({ start: p.start, end: b.start })
      if (b.end < p.end) next.push({ start: b.end, end: p.end })
    }
    pieces = next
  }
  return pieces
}

function buildFreeIntervals(
  days: Date[],
  windowsByWeekday: Map<number, Array<[number, number]>>,
  busy: Interval[],
  horizonStart: Date,
  horizonEnd: Date,
): Map<string, Interval[]> {
  const free = new Map<string, Interval[]>()
  for (const day of days) {
    const windows = windowsByWeekday.size
      ? (windowsByWeekday.get(day.getDay()) ?? [])
      : [DEFAULT_WINDOW]
    const intervals: Interval[] = []
    for (const [startMin, endMin] of [...windows].sort((a, b) => a[0] - b[0])) {
      const spanStart = new Date(
        Math.max(addMinutes(day, startMin).getTime(), horizonStart.getTime()),
      )
      const spanEnd = new Date(
        Math.min(addMinutes(day, endMin).getTime(), horizonEnd.getTime()),
      )
      if (spanStart >= spanEnd) continue
      for (const piece of subtractBusy({ start: spanStart, end: spanEnd }, busy)) {
        const start = snapUp(piece.start)
        if (differenceInMinutes(piece.end, start) >= SLOT_MINUTES) {
          intervals.push({ start, end: piece.end })
        }
      }
    }
    intervals.sort((a, b) => a.start.getTime() - b.start.getTime())
    free.set(dayKeyOf(day), intervals)
  }
  return free
}

function inPreferred(start: Date, windows: EnginePreferredWindow[]): boolean {
  const startMin = start.getHours() * 60 + start.getMinutes()
  return windows.some(
    (w) => w.weekday === start.getDay() && w.startMin <= startMin && startMin < w.endMin,
  )
}

function desiredChunk(task: EngineTask): number {
  let desired = Math.max(DEFAULT_CHUNK_MINUTES, task.minBlockMinutes ?? SLOT_MINUTES)
  if (task.maxBlockMinutes) desired = Math.min(desired, task.maxBlockMinutes)
  return Math.max(SLOT_MINUTES, desired)
}

function candidateStarts(lo: Date, hi: Date, day: Date, task: EngineTask): Date[] {
  const starts = new Map<number, Date>([[lo.getTime(), lo]])
  for (const w of task.preferredWindows) {
    if (w.weekday !== day.getDay()) continue
    const windowStart = snapUp(addMinutes(day, w.startMin))
    if (lo < windowStart && windowStart < hi) starts.set(windowStart.getTime(), windowStart)
  }
  return [...starts.values()].sort((a, b) => a.getTime() - b.getTime())
}

function capacityBeforeDeadline(
  task: EngineTask,
  days: Date[],
  free: Map<string, Interval[]>,
  dayLoad: Map<string, number>,
  cap: number | null,
): number {
  let total = 0
  for (const day of days) {
    let dayMinutes = 0
    for (const iv of free.get(dayKeyOf(day)) ?? []) {
      const clippedEnd = new Date(Math.min(iv.end.getTime(), task.deadline.getTime()))
      if (iv.start < clippedEnd) dayMinutes += differenceInMinutes(clippedEnd, iv.start)
    }
    if (cap !== null) {
      dayMinutes = Math.min(dayMinutes, Math.max(0, cap - (dayLoad.get(dayKeyOf(day)) ?? 0)))
    }
    total += dayMinutes
  }
  return total
}

function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function findCandidates(
  task: EngineTask,
  remaining: number,
  days: Date[],
  free: Map<string, Interval[]>,
  dayLoad: Map<string, number>,
  cap: number | null,
  overloadAllowed: boolean,
): Candidate[] {
  const desired = desiredChunk(task)
  const minBlock = task.minBlockMinutes ?? SLOT_MINUTES
  const denom = cap || FALLBACK_DAY_MINUTES
  const candidates: Candidate[] = []
  days.forEach((day, dayIndex) => {
    const dayKey = dayKeyOf(day)
    const load = dayLoad.get(dayKey) ?? 0
    let capLeft: number | null = null
    if (cap !== null && !overloadAllowed) {
      capLeft = cap - load
      if (capLeft < SLOT_MINUTES) return
    }
    const intervals = free.get(dayKey) ?? []
    intervals.forEach((iv, intervalIndex) => {
      let lo = iv.start
      if (task.earliestStartAt && lo < task.earliestStartAt) {
        lo = snapUp(task.earliestStartAt)
      }
      const hi = new Date(Math.min(iv.end.getTime(), task.deadline.getTime()))
      if (differenceInMinutes(hi, lo) < SLOT_MINUTES) return
      for (const start of candidateStarts(lo, hi, day, task)) {
        const avail = differenceInMinutes(hi, start)
        if (avail < SLOT_MINUTES) continue
        let chunk: number
        if (!task.splittable) {
          chunk = remaining
          if (avail < chunk || (capLeft !== null && capLeft < chunk)) continue
        } else {
          chunk = Math.min(remaining, desired, avail)
          if (capLeft !== null) chunk = Math.min(chunk, capLeft)
          chunk -= chunk % SLOT_MINUTES
          if (chunk < SLOT_MINUTES) continue
          // never create a sub-minBlock piece unless it finishes the task
          if (chunk < minBlock && chunk < remaining) continue
        }
        const preferred = inPreferred(start, task.preferredWindows)
        let score: number[]
        if (overloadAllowed) {
          const overloadAfter = cap !== null ? Math.max(0, load + chunk - cap) : 0
          score = [-overloadAfter, -(load + chunk), -dayIndex]
        } else {
          score = [
            -(load / denom) * BALANCE_WEIGHT
              + (preferred ? PREFERRED_BONUS : 0)
              + (chunk / desired) * CHUNK_BONUS
              - dayIndex * EARLY_DAY_PENALTY,
          ]
        }
        candidates.push({ score, dayIndex, dayKey, intervalIndex, start, chunk })
      }
    })
  })
  return candidates
}

function pick(candidates: Candidate[]): Candidate {
  // best score wins; ties go to the earlier day, then earlier start
  return candidates.reduce((best, c) => {
    const diff = compareScores(c.score, best.score)
    if (diff > 0) return c
    if (diff < 0) return best
    if (c.dayIndex !== best.dayIndex) return c.dayIndex < best.dayIndex ? c : best
    return c.start < best.start ? c : best
  })
}

function place(free: Map<string, Interval[]>, chosen: Candidate): Interval {
  const intervals = free.get(chosen.dayKey) ?? []
  const iv = intervals[chosen.intervalIndex]
  const blockStart = chosen.start
  const blockEnd = addMinutes(blockStart, chosen.chunk)
  const replacement: Interval[] = []
  if (differenceInMinutes(blockStart, iv.start) >= SLOT_MINUTES) {
    replacement.push({ start: iv.start, end: blockStart })
  }
  if (differenceInMinutes(iv.end, blockEnd) >= SLOT_MINUTES) {
    replacement.push({ start: snapUp(blockEnd), end: iv.end })
  }
  free.set(chosen.dayKey, [
    ...intervals.slice(0, chosen.intervalIndex),
    ...replacement,
    ...intervals.slice(chosen.intervalIndex + 1),
  ])
  return { start: blockStart, end: blockEnd }
}

function scheduleTask(
  task: EngineTask,
  remaining: number,
  days: Date[],
  free: Map<string, Interval[]>,
  dayLoad: Map<string, number>,
  cap: number | null,
  overloadAllowed: boolean,
  blocks: EngineBlock[],
  overloadByDay: Map<string, number>,
): number {
  while (remaining >= SLOT_MINUTES) {
    const candidates = findCandidates(
      task, remaining, days, free, dayLoad, cap, overloadAllowed,
    )
    if (!candidates.length) break
    const chosen = pick(candidates)
    const placed = place(free, chosen)
    const previousLoad = dayLoad.get(chosen.dayKey) ?? 0
    dayLoad.set(chosen.dayKey, previousLoad + chosen.chunk)
    const overloaded =
      overloadAllowed && cap !== null && (dayLoad.get(chosen.dayKey) ?? 0) > cap
    if (overloaded && cap !== null) {
      const alreadyOver = Math.max(0, previousLoad - cap)
      const newlyOver = (dayLoad.get(chosen.dayKey) ?? 0) - cap - alreadyOver
      overloadByDay.set(chosen.dayKey, (overloadByDay.get(chosen.dayKey) ?? 0) + newlyOver)
    }
    blocks.push({ taskId: task.id, startAt: placed.start, endAt: placed.end, overloaded })
    remaining -= chosen.chunk
    if (!task.splittable) break
  }
  return remaining
}

export function scheduleEngine(options: {
  now: Date
  tasks: EngineTask[]
  windowsByWeekday: Map<number, Array<[number, number]>>
  busy: Array<[Date, Date]>
  initialDayLoad: Map<string, number>
  dailyMaxMinutes: number | null
}): EngineResult {
  const { now, tasks, windowsByWeekday, dailyMaxMinutes: cap } = options
  const horizonStart = snapUp(now)
  const horizonCap = addDays(now, MAX_HORIZON_DAYS)
  const latestDeadline = tasks.reduce(
    (latest, t) => (t.deadline > latest ? t.deadline : latest),
    horizonStart,
  )
  const horizonEnd = new Date(Math.min(latestDeadline.getTime(), horizonCap.getTime()))

  const days: Date[] = []
  for (let day = startOfDay(horizonStart); day <= horizonEnd; day = addDays(day, 1)) {
    days.push(day)
  }

  const busy = options.busy.map(([start, end]) => ({ start, end }))
  const free = buildFreeIntervals(days, windowsByWeekday, busy, horizonStart, horizonEnd)
  const dayLoad = new Map(options.initialDayLoad)

  const warnings: EngineWarning[] = []
  const pending = tasks.filter((t) => t.remainingMinutes > 0)
  const ordered = [...pending].sort((a, b) => {
    const deadlineDiff = a.deadline.getTime() - b.deadline.getTime()
    if (deadlineDiff) return deadlineDiff
    const capacityDiff =
      capacityBeforeDeadline(a, days, free, dayLoad, cap) -
      capacityBeforeDeadline(b, days, free, dayLoad, cap)
    if (capacityDiff) return capacityDiff
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank
    return a.id.localeCompare(b.id)
  })

  const blocks: EngineBlock[] = []
  const overloadByDay = new Map<string, number>()
  const remainingByTask = new Map<string, number>()
  const requestedByTask = new Map<string, number>()
  const phase2Queue: Array<[EngineTask, number]> = []

  for (const task of ordered) {
    const requested = Math.ceil(task.remainingMinutes / SLOT_MINUTES) * SLOT_MINUTES
    requestedByTask.set(task.id, requested)
    if (task.deadline > horizonCap) {
      warnings.push({ kind: 'beyond_horizon', taskId: task.id })
    }
    const remaining = scheduleTask(
      task, requested, days, free, dayLoad, cap, false, blocks, overloadByDay,
    )
    remainingByTask.set(task.id, remaining)
    if (remaining > 0 && cap !== null) phase2Queue.push([task, remaining])
  }

  // Phase 2: only work that cannot fit before its deadline under the cap may
  // overload days, as evenly and as little as possible.
  for (const [task, queued] of phase2Queue) {
    const overloadBefore = new Map(overloadByDay)
    const remaining = scheduleTask(
      task, queued, days, free, dayLoad, cap, true, blocks, overloadByDay,
    )
    remainingByTask.set(task.id, remaining)
    for (const dayKey of [...overloadByDay.keys()].sort()) {
      const extra = (overloadByDay.get(dayKey) ?? 0) - (overloadBefore.get(dayKey) ?? 0)
      if (extra > 0) {
        warnings.push({
          kind: 'overload',
          taskId: task.id,
          day: dayKey,
          capMinutes: cap ?? 0,
          extraMinutes: extra,
        })
      }
    }
  }

  const stats: EngineTaskStat[] = []
  for (const task of ordered) {
    const requested = requestedByTask.get(task.id) ?? 0
    const remaining = remainingByTask.get(task.id) ?? 0
    const placed = requested - remaining
    stats.push({ taskId: task.id, placedMinutes: placed, remainingMinutes: remaining })
    if (remaining <= 0) continue
    if (placed === 0) {
      warnings.push({
        kind: task.splittable ? 'no_slot' : 'non_splittable',
        taskId: task.id,
        requestedMinutes: requested,
      })
    } else {
      warnings.push({
        kind: 'partial',
        taskId: task.id,
        requestedMinutes: requested,
        placedMinutes: placed,
      })
    }
  }

  blocks.sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime() || a.taskId.localeCompare(b.taskId),
  )
  return { blocks, warnings, stats }
}
