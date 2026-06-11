import type { Priority, TaskStatus, TaskType } from '../types'

export const TYPE_LABELS: Record<TaskType, string> = {
  assignment: '作业',
  exam: '考试',
  project: '项目',
  admin: '事务',
  personal: '个人',
  research: '科研',
  coding: '编程',
  other: '其他',
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  active: '进行中',
  completed: '已完成',
  archived: '已归档',
}

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Monday-first display order using JS getDay() values. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export const priorityColor: Record<Priority, string> = {
  urgent: 'border-red-300 bg-red-50 text-red-800',
  high: 'border-orange-300 bg-orange-50 text-orange-800',
  medium: 'border-blue-300 bg-blue-50 text-blue-800',
  low: 'border-gray-300 bg-gray-50 text-gray-700',
}
