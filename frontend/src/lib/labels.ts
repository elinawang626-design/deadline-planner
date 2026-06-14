import type { Priority, TaskStatus, TaskType } from '../types'
import { t } from '../i18n'

const TASK_TYPES: TaskType[] = [
  'assignment', 'exam', 'project', 'admin', 'personal', 'research', 'coding', 'other',
]
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent']
const STATUSES: TaskStatus[] = ['active', 'completed', 'archived']

/**
 * Language-aware label maps. Each behaves like the original Record/array but
 * resolves the current language at access time, so index access, `Object.entries`
 * and `.map` all keep working while the UI can switch languages live (the tree
 * re-renders on language change via the i18n store in App).
 */
function labelMap<K extends string>(ns: string, keys: K[]): Record<K, string> {
  return new Proxy({} as Record<K, string>, {
    get: (_target, prop: string) => t(`${ns}.${prop}`),
    ownKeys: () => [...keys],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  })
}

export const TYPE_LABELS = labelMap<TaskType>('type', TASK_TYPES)
export const PRIORITY_LABELS = labelMap<Priority>('priority', PRIORITIES)
export const STATUS_LABELS = labelMap<TaskStatus>('status', STATUSES)

/** Indexed by JS getDay() value (0 = Sunday). */
export const WEEKDAY_LABELS = new Proxy([] as unknown as string[], {
  get: (_target, prop: string) => t(`weekday.${prop}`),
}) as unknown as readonly string[]

/** Monday-first display order using JS getDay() values. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export function fmtMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (!h) return `${m}m`
  return m ? `${h}h${m}m` : `${h}h`
}

export const priorityColor: Record<Priority, string> = {
  urgent: 'border-red-300 bg-red-50 text-red-800',
  high: 'border-orange-300 bg-orange-50 text-orange-800',
  medium: 'border-blue-300 bg-blue-50 text-blue-800',
  low: 'border-gray-300 bg-gray-50 text-gray-700',
}
