import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { listTasks } from '../../api/tasks'
import { createPlan } from '../../api/plans'
import { useUI } from '../../store/ui'
import { Modal } from '../ui/Modal'
import { PRIORITY_LABELS } from '../../lib/labels'
import { useT } from '../../i18n'
import type { PlanCreate, Priority } from '../../types'

const inputCls =
  'w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none'
const labelCls = 'mb-1 block text-xs font-medium text-gray-600'

interface PlanFormProps {
  /** "yyyy-MM-dd"; defaults to today. */
  defaultDate?: string
  onClose: () => void
}

export function PlanForm({ defaultDate, onClose }: PlanFormProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const setLastSummary = useUI((s) => s.setLastSummary)
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: listTasks })
  const activeTasks = tasks.filter((t) => t.status === 'active')

  const [mode, setMode] = useState<'existing' | 'new'>(activeTasks.length ? 'existing' : 'new')
  const [taskId, setTaskId] = useState('')

  // new-task fields
  const [title, setTitle] = useState('')
  const [deadlineDate, setDeadlineDate] = useState(defaultDate ?? '')
  const [deadlineTime, setDeadlineTime] = useState('18:00')
  const [hours, setHours] = useState('1')
  const [minutes, setMinutes] = useState('0')
  const [priority, setPriority] = useState<Priority>('medium')
  const [splittable, setSplittable] = useState(true)
  const [minBlock, setMinBlock] = useState('')
  const [maxBlock, setMaxBlock] = useState('')

  // plan fields
  const [date, setDate] = useState(defaultDate ?? format(new Date(), 'yyyy-MM-dd'))
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [notes, setNotes] = useState('')

  const mutation = useMutation({
    mutationFn: async () => {
      if (!date) throw new Error(t('planForm.dateRequired'))
      const startAt = new Date(`${date}T${startTime}`)
      const endAt = new Date(`${date}T${endTime}`)
      if (!(startAt < endAt)) throw new Error(t('planForm.endAfterStart'))
      const payload: PlanCreate = {
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        notes: notes.trim() || undefined,
      }
      if (mode === 'existing') {
        if (!taskId) throw new Error(t('planForm.selectOneTask'))
        payload.taskId = taskId
      } else {
        const estimatedMinutes = Number(hours || 0) * 60 + Number(minutes || 0)
        if (!title.trim()) throw new Error(t('taskForm.titleRequired'))
        if (estimatedMinutes <= 0) throw new Error(t('taskForm.durationPositive'))
        payload.newTask = {
          title: title.trim(),
          type: 'other',
          deadline: deadlineDate
            ? new Date(`${deadlineDate}T${deadlineTime || '23:59'}`).toISOString()
            : null,
          estimatedMinutes,
          priority,
          splittable,
          minBlockMinutes: minBlock ? Number(minBlock) : undefined,
          maxBlockMinutes: maxBlock ? Number(maxBlock) : undefined,
        }
      }
      return createPlan(payload)
    },
    onSuccess: (result) => {
      setLastSummary(result.summary)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['blocks'] })
      pushToast('success', t('planForm.created'))
      for (const warning of result.warnings) {
        pushToast('error', warning.message)
      }
      onClose()
    },
    onError: (error: unknown) =>
      pushToast('error', error instanceof Error ? error.message : t('common.saveFailed')),
  })

  return (
    <Modal title={t('planForm.title')} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          mutation.mutate()
        }}
        className="flex flex-col gap-3"
      >
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
            />
            {t('planForm.bindExisting')}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
            {t('planForm.createNew')}
          </label>
        </div>

        {mode === 'existing' ? (
          <div>
            <label className={labelCls}>{t('planForm.task')}</label>
            <select className={inputCls} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">{t('planForm.selectTask')}</option>
              {activeTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                  {task.deadline
                    ? t('planForm.taskDeadline', { time: format(new Date(task.deadline), 'M/d HH:mm') })
                    : t('planForm.taskNoDeadline')}
                </option>
              ))}
            </select>
            {activeTasks.length === 0 && (
              <p className="mt-1 text-xs text-gray-500">{t('planForm.noActiveTasks')}</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 rounded-md border border-gray-200 p-3">
            <div className="col-span-2">
              <label className={labelCls}>{t('form.title')}</label>
              <input autoFocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>{t('planForm.deadlineDate')}</label>
              <input type="date" className={inputCls} value={deadlineDate} onChange={(e) => setDeadlineDate(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>{t('form.deadlineTime')}</label>
              <input type="time" className={inputCls} value={deadlineTime} onChange={(e) => setDeadlineTime(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>{t('planForm.estimatedTotal')}</label>
              <div className="flex gap-2">
                <input type="number" min="0" className={inputCls} value={hours} onChange={(e) => setHours(e.target.value)} />
                <input type="number" min="0" max="59" step="15" className={inputCls} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={labelCls}>{t('form.priority')}</label>
              <select className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('form.minBlock')}</label>
              <input type="number" min="0" step="15" className={inputCls} value={minBlock} onChange={(e) => setMinBlock(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>{t('form.maxBlock')}</label>
              <input type="number" min="0" step="15" className={inputCls} value={maxBlock} onChange={(e) => setMaxBlock(e.target.value)} />
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <input id="plan-splittable" type="checkbox" checked={splittable} onChange={(e) => setSplittable(e.target.checked)} />
              <label htmlFor="plan-splittable" className="text-sm">{t('form.splittable')}</label>
            </div>
            <p className="col-span-2 text-xs text-gray-500">
              {t('planForm.totalNote')}
            </p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>{t('planForm.date')}</label>
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>{t('planForm.startTime')}</label>
            <input type="time" className={inputCls} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>{t('planForm.endTime')}</label>
            <input type="time" className={inputCls} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={labelCls}>{t('form.notes')}</label>
          <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <p className="text-xs text-gray-500">
          {t('planForm.lockNote')}
        </p>
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-4 py-1.5 text-sm hover:bg-gray-50">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={mutation.isPending} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
            {mutation.isPending ? t('common.saving') : t('planForm.save')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
