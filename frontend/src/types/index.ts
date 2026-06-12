export type TaskType =
  | 'assignment' | 'exam' | 'project' | 'admin'
  | 'personal' | 'research' | 'coding' | 'other'

export type Priority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskStatus = 'active' | 'completed' | 'archived'
/** Who placed a block: external AI, the local scheduler, or the user. */
export type BlockSource = 'ai' | 'local_auto' | 'manual'

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
  | 'outside_availability'
  | 'past_deadline'

export interface ScheduleWarning {
  type: ScheduleWarningType
  message: string
  taskId?: string
}

export interface TaskScheduleStat {
  taskId: string
  scheduledMinutes: number
  unscheduledMinutes: number
}

export interface ScheduleSummary {
  createdBlocks: number
  removedBlocks: number
  unscheduledTaskIds: string[]
  totalUnscheduledMinutes: number
  taskStats: TaskScheduleStat[]
  warnings: ScheduleWarning[]
}

/** Atomic manual plan: bind an existing task or create a new one with it. */
export interface PlanCreate {
  taskId?: string
  newTask?: Omit<Task, 'id' | 'createdAt' | 'status'> & { status?: TaskStatus }
  startAt: string // ISO 8601
  endAt: string // ISO 8601
  notes?: string
}

export interface PlanCreateResult {
  task: Task
  block: ScheduledBlock
  warnings: ScheduleWarning[]
  summary: ScheduleSummary
}

export interface Settings {
  dailyMaxPlannedHours: number
}

// ---- AI plan import (manual copy/paste LLM workflow) ----

export type PlanMode = 'ai_plan' | 'ai_optimize' | 'tasks_only'

export type ChangeKind =
  | 'task_add' | 'task_update' | 'task_delete'
  | 'event_add' | 'event_update' | 'event_delete'
  | 'availability_add' | 'availability_update' | 'availability_delete'
  | 'block_add' | 'block_move' | 'block_remove'

export interface FieldChange {
  field: string
  old?: unknown
  new?: unknown
}

export interface PlanChange {
  changeId: string
  kind: ChangeKind
  targetId: string
  summary: string
  fields: FieldChange[]
  dependsOn: string[]
}

export interface KeptBlock {
  id: string
  taskId: string
  startAt: string
  endAt: string
  reason: 'manual' | 'locked' | 'done' | 'past' | 'not_replaced'
}

export interface PlanPreview {
  ok: boolean
  errors: string[]
  warnings: string[]
  previewVersion: string
  summary: Record<string, number>
  changes: PlanChange[]
  keptBlocks: KeptBlock[]
  useLocalScheduler: boolean
}

export interface PlanImportResult {
  applied: number
  rejected: number
  scheduleSummary?: ScheduleSummary | null
}

// ---- task tracking (checklist / work logs / attachments / estimates / career) ----

export type StorageMode = 'copy' | 'link'
export type ExtractionStatus = 'ok' | 'failed' | 'unsupported'
export type Confidence = 'low' | 'medium' | 'high'

export interface ChecklistItem {
  id: string
  taskId: string
  title: string
  completed: boolean
  position: number
  createdAt: string
}

export interface WorkLog {
  id: string
  taskId: string
  workedAt: string // "YYYY-MM-DD"
  durationMinutes: number
  summary: string
  challenge?: string
  result?: string
  createdAt: string
}

export interface Attachment {
  id: string
  taskId: string
  displayName: string
  storageMode: StorageMode
  originalPath?: string
  storedPath?: string
  mimeType?: string
  sizeBytes: number
  description?: string
  extractionStatus: ExtractionStatus
  extractedText?: string
  createdAt: string
}

export interface EstimateStep {
  step: string
  minutes: number
}

export interface Estimate {
  id: string
  taskId: string
  optimisticMinutes: number
  likelyMinutes: number
  pessimisticMinutes: number
  confidence: Confidence
  breakdown: EstimateStep[]
  assumptions: string[]
  risks: string[]
  sourceAttachmentIds: string[]
  createdAt: string
  appliedAt?: string | null
}

export interface ExcerptPreview {
  attachmentId: string
  displayName: string
  snippets: string[]
}

export interface EstimatePromptResult {
  prompt: string
  excerpts: ExcerptPreview[]
}

export interface ApplyEstimateResult {
  task: Task
  estimate: Estimate
  summary: ScheduleSummary
}

export interface CareerCard {
  id: string
  taskId: string
  context: string
  role: string
  actions: string[]
  challenges: string[]
  outcomes: string[]
  metrics: string[]
  skills: string[]
  evidenceAttachmentIds: string[]
  createdAt: string
  updatedAt: string
}

export interface TrackingSummary {
  taskId: string
  checklistDone: number
  checklistTotal: number
  actualMinutes: number
  attachmentCount: number
}
