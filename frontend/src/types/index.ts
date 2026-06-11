export type TaskType =
  | 'assignment' | 'exam' | 'project' | 'admin'
  | 'personal' | 'research' | 'coding' | 'other'

export type Priority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskStatus = 'active' | 'completed' | 'archived'
export type BlockSource = 'auto' | 'manual'

/** weekday uses the JS Date#getDay() convention: 0 = Sunday. */
export interface PreferredWindow {
  weekday: number
  startTime: string // "HH:mm"
  endTime: string // "HH:mm"
}

export interface Task {
  id: string
  title: string
  description?: string
  type: TaskType
  deadline: string // ISO 8601
  estimatedMinutes: number
  earliestStartAt?: string // ISO 8601
  priority: Priority
  splittable: boolean
  minBlockMinutes?: number
  maxBlockMinutes?: number
  preferredWindows?: PreferredWindow[]
  notes?: string
  status: TaskStatus
  createdAt: string
}

export interface ScheduledBlock {
  id: string
  taskId: string
  startAt: string // ISO 8601
  endAt: string // ISO 8601
  locked: boolean
  source: BlockSource
  done: boolean
  notes?: string
}

export interface AvailabilityWindow {
  id: string
  weekday: number // 0 = Sunday
  startTime: string // "HH:mm"
  endTime: string // "HH:mm"
}

export interface FixedEvent {
  id: string
  title: string
  startAt: string
  endAt: string
}

export type ScheduleWarningType =
  | 'insufficient_time'
  | 'deadline_unreachable'
  | 'overloaded_day'
  | 'overlap'
  | 'missing_estimate'

export interface ScheduleWarning {
  type: ScheduleWarningType
  message: string
  taskId?: string
}

export interface ScheduleSummary {
  createdBlocks: number
  removedBlocks: number
  unscheduledTaskIds: string[]
  warnings: ScheduleWarning[]
}

export interface Settings {
  dailyMaxPlannedHours: number
}
