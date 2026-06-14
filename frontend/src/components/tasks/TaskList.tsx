import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { addDays, format, parseISO } from 'date-fns'
import { deleteTask, updateTask } from '../../api/tasks'
import { useUI } from '../../store/ui'
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  fmtMinutes,
  priorityColor,
} from '../../lib/labels'
import { useT } from '../../i18n'
import type { Priority, ScheduledBlock, Task, TrackingSummary } from '../../types'

type Filter = 'active' | 'completed' | 'archived' | 'overdue' | 'week'

const FILTER_KEYS: Filter[] = ['active', 'overdue', 'week', 'completed', 'archived']

interface TaskListProps {
  tasks: Task[]
  blocks: ScheduledBlock[]
  onEdit: (task: Task) => void
  tracking?: Record<string, TrackingSummary>
}

export function TaskList({ tasks, blocks, onEdit, tracking = {} }: TaskListProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const filters = FILTER_KEYS.map((key) => ({ key, label: t(`taskList.filter.${key}`) }))
  const [filter, setFilter] = useState<Filter>('active')
  const [priorityFilter, setPriorityFilter] = useState<'all' | Priority>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['tasks'] })
    queryClient.invalidateQueries({ queryKey: ['blocks'] })
  }
  const patchTask = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Task> }) => updateTask(id, patch),
    onSuccess: invalidate,
    onError: (error: unknown) =>
      pushToast('error', error instanceof Error ? error.message : t('common.updateFailed')),
  })
  const removeTask = useMutation({
    mutationFn: (id: string) => deleteTask(id),
    onSuccess: () => {
      invalidate()
      pushToast('success', t('taskList.deleted'))
    },
  })

  const now = new Date()
  const weekEnd = addDays(now, 7)
  const visible = tasks.filter((task) => {
    if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false
    switch (filter) {
      case 'active':
        return task.status === 'active'
      case 'completed':
        return task.status === 'completed'
      case 'archived':
        return task.status === 'archived'
      case 'overdue':
        return task.status === 'active' && !!task.deadline && parseISO(task.deadline) < now
      case 'week':
        return (
          task.status === 'active' &&
          !!task.deadline &&
          parseISO(task.deadline) >= now &&
          parseISO(task.deadline) <= weekEnd
        )
    }
  })

  const scheduledMinutes = (taskId: string) =>
    blocks
      .filter((b) => b.taskId === taskId)
      .reduce(
        (sum, b) => sum + (parseISO(b.endAt).getTime() - parseISO(b.startAt).getTime()) / 60_000,
        0,
      )

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-sm ${
              filter === f.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}
          >
            {f.label}
          </button>
        ))}
        <select
          className="ml-auto rounded-md border border-gray-300 px-2 py-1 text-sm"
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value as 'all' | Priority)}
        >
          <option value="all">{t('taskList.allPriorities')}</option>
          {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
      {visible.length === 0 && (
        <p className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400">
          {t('taskList.empty')}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {visible.map((task) => {
          const scheduled = scheduledMinutes(task.id)
          const remaining = Math.max(0, task.estimatedMinutes - scheduled)
          const overdue =
            task.status === 'active' && !!task.deadline && parseISO(task.deadline) < now
          const taskBlocks = blocks
            .filter((b) => b.taskId === task.id)
            .sort((a, b) => a.startAt.localeCompare(b.startAt))
          return (
            <div key={task.id} className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded border px-1.5 py-0.5 text-xs ${priorityColor[task.priority]}`}>
                  {PRIORITY_LABELS[task.priority]}
                </span>
                <span className="font-medium">{task.title}</span>
                <span className="text-xs text-gray-400">{TYPE_LABELS[task.type]}</span>
                <span className={`text-xs ${overdue ? 'font-medium text-red-600' : 'text-gray-500'}`}>
                  {task.deadline
                    ? t('taskList.deadline', { time: format(parseISO(task.deadline), 'M/d HH:mm') })
                    : t('taskList.noDeadline')}
                  {overdue && t('taskList.overdueTag')}
                </span>
                <span className="text-xs text-gray-400">{STATUS_LABELS[task.status]}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
                <span>{t('taskList.estimated', { value: fmtMinutes(task.estimatedMinutes) })}</span>
                <span>{t('taskList.scheduledTime', { value: fmtMinutes(scheduled) })}</span>
                <span>{t('taskList.remaining', { value: fmtMinutes(remaining) })}</span>
                {task.earliestStartAt && (
                  <span>{t('taskList.earliestStart', { time: format(parseISO(task.earliestStartAt), 'M/d HH:mm') })}</span>
                )}
                {tracking[task.id] && (
                  <>
                    {tracking[task.id].checklistTotal > 0 && (
                      <span>
                        {t('taskList.checklist', {
                          done: tracking[task.id].checklistDone,
                          total: tracking[task.id].checklistTotal,
                        })}
                      </span>
                    )}
                    {tracking[task.id].actualMinutes > 0 && (
                      <span>{t('taskList.actual', { value: fmtMinutes(tracking[task.id].actualMinutes) })}</span>
                    )}
                    {tracking[task.id].attachmentCount > 0 && (
                      <span>{t('taskList.attachments', { count: tracking[task.id].attachmentCount })}</span>
                    )}
                  </>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <Link to={`/tasks/${task.id}`} className="font-medium text-blue-600 hover:underline">
                  {t('common.detail')}
                </Link>
                <button onClick={() => onEdit(task)} className="text-blue-600 hover:underline">{t('common.edit')}</button>
                {task.status === 'active' ? (
                  <button
                    onClick={() => patchTask.mutate({ id: task.id, patch: { status: 'completed' } })}
                    className="text-green-700 hover:underline"
                  >
                    {t('taskList.markComplete')}
                  </button>
                ) : (
                  <button
                    onClick={() => patchTask.mutate({ id: task.id, patch: { status: 'active' } })}
                    className="text-gray-600 hover:underline"
                  >
                    {t('taskList.restoreActive')}
                  </button>
                )}
                {task.status !== 'archived' && (
                  <button
                    onClick={() => patchTask.mutate({ id: task.id, patch: { status: 'archived' } })}
                    className="text-gray-600 hover:underline"
                  >
                    {t('taskList.archive')}
                  </button>
                )}
                <button
                  onClick={() => {
                    if (window.confirm(t('taskList.confirmDelete', { title: task.title }))) {
                      removeTask.mutate(task.id)
                    }
                  }}
                  className="text-red-600 hover:underline"
                >
                  {t('common.delete')}
                </button>
                <button
                  onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
                  className="text-gray-600 hover:underline"
                >
                  {expandedId === task.id
                    ? t('taskList.collapseBlocks')
                    : t('taskList.blocks', { count: taskBlocks.length })}
                </button>
              </div>
              {expandedId === task.id && (
                <div className="mt-2 rounded-md bg-gray-50 p-2 text-xs text-gray-600">
                  {taskBlocks.length === 0 && <p>{t('taskList.noBlocks')}</p>}
                  {taskBlocks.map((b) => (
                    <p key={b.id}>
                      {format(parseISO(b.startAt), 'M/d HH:mm')}–{format(parseISO(b.endAt), 'HH:mm')}
                      {b.locked && ' 🔒'}
                      {b.source === 'manual' && t('taskList.blockManual')}
                      {b.done && t('taskList.blockDone')}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
