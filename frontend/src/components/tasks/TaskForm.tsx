import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { createTask, updateTask, type TaskCreate } from '../../api/tasks'
import { regenerateSchedule } from '../../api/schedule'
import { useUI } from '../../store/ui'
import { Modal } from '../ui/Modal'
import { PRIORITY_LABELS, TYPE_LABELS, WEEKDAY_LABELS, WEEKDAY_ORDER } from '../../lib/labels'
import { useT } from '../../i18n'
import type { Priority, Task, TaskType } from '../../types'

const inputCls =
  'w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none'
const labelCls = 'mb-1 block text-xs font-medium text-gray-600'

interface TaskFormProps {
  initial?: Task
  /** "yyyy-MM-dd" deadline prefill for new tasks (the clicked calendar date). */
  initialDeadlineDate?: string
  onClose: () => void
}

export function TaskForm({ initial, initialDeadlineDate, onClose }: TaskFormProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const setLastSummary = useUI((s) => s.setLastSummary)

  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [type, setType] = useState<TaskType>(initial?.type ?? 'assignment')
  const [deadlineDate, setDeadlineDate] = useState(
    initial?.deadline
      ? format(parseISO(initial.deadline), 'yyyy-MM-dd')
      : (initialDeadlineDate ?? ''),
  )
  const [deadlineTime, setDeadlineTime] = useState(
    initial?.deadline ? format(parseISO(initial.deadline), 'HH:mm') : '18:00',
  )
  const [hours, setHours] = useState(
    initial ? String(Math.floor(initial.estimatedMinutes / 60)) : '1',
  )
  const [minutes, setMinutes] = useState(initial ? String(initial.estimatedMinutes % 60) : '0')
  const [earliestStart, setEarliestStart] = useState(
    initial?.earliestStartAt
      ? format(parseISO(initial.earliestStartAt), "yyyy-MM-dd'T'HH:mm")
      : '',
  )
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 'medium')
  const [splittable, setSplittable] = useState(initial?.splittable ?? true)
  const [minBlock, setMinBlock] = useState(
    initial?.minBlockMinutes ? String(initial.minBlockMinutes) : '',
  )
  const [maxBlock, setMaxBlock] = useState(
    initial?.maxBlockMinutes ? String(initial.maxBlockMinutes) : '',
  )
  const existingWindow = initial?.preferredWindows?.[0]
  const [pwEnabled, setPwEnabled] = useState(Boolean(existingWindow))
  const [pwWeekday, setPwWeekday] = useState(existingWindow ? String(existingWindow.weekday) : '1')
  const [pwStart, setPwStart] = useState(existingWindow?.startTime ?? '19:00')
  const [pwEnd, setPwEnd] = useState(existingWindow?.endTime ?? '22:00')
  const [notes, setNotes] = useState(initial?.notes ?? '')

  const mutation = useMutation({
    mutationFn: async () => {
      const estimatedMinutes = Number(hours || 0) * 60 + Number(minutes || 0)
      if (!title.trim()) throw new Error(t('taskForm.titleRequired'))
      if (estimatedMinutes <= 0) throw new Error(t('taskForm.durationPositive'))
      const payload: TaskCreate = {
        title: title.trim(),
        description: description.trim() || undefined,
        type,
        deadline: deadlineDate
          ? new Date(`${deadlineDate}T${deadlineTime || '23:59'}`).toISOString()
          : null,
        estimatedMinutes,
        earliestStartAt: earliestStart ? new Date(earliestStart).toISOString() : undefined,
        priority,
        splittable,
        minBlockMinutes: minBlock ? Number(minBlock) : undefined,
        maxBlockMinutes: maxBlock ? Number(maxBlock) : undefined,
        preferredWindows: pwEnabled
          ? [{ weekday: Number(pwWeekday), startTime: pwStart, endTime: pwEnd }]
          : undefined,
        notes: notes.trim() || undefined,
      }
      if (initial) await updateTask(initial.id, payload)
      else await createTask(payload)
      return regenerateSchedule()
    },
    onSuccess: (summary) => {
      setLastSummary(summary)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['blocks'] })
      pushToast('success', initial ? t('taskForm.updated') : t('taskForm.created'))
      onClose()
    },
    onError: (error: unknown) =>
      pushToast('error', error instanceof Error ? error.message : t('common.saveFailed')),
  })

  return (
    <Modal title={initial ? t('taskForm.editTitle') : t('taskForm.newTitle')} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          mutation.mutate()
        }}
        className="grid grid-cols-2 gap-3"
      >
        <div className="col-span-2">
          <label className={labelCls}>{t('form.title')}</label>
          <input autoFocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className={labelCls}>{t('form.description')}</label>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>{t('form.type')}</label>
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as TaskType)}>
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
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
          <label className={labelCls}>{t('taskForm.deadlineDate')}</label>
          <input type="date" className={inputCls} value={deadlineDate} onChange={(e) => setDeadlineDate(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>{t('form.deadlineTime')}</label>
          <input type="time" className={inputCls} value={deadlineTime} onChange={(e) => setDeadlineTime(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>{t('taskForm.estimatedDuration')}</label>
          <div className="flex gap-2">
            <input type="number" min="0" className={inputCls} value={hours} onChange={(e) => setHours(e.target.value)} />
            <input type="number" min="0" max="59" step="15" className={inputCls} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={labelCls}>{t('form.earliestStart')}</label>
          <input type="datetime-local" className={inputCls} value={earliestStart} onChange={(e) => setEarliestStart(e.target.value)} />
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
          <input id="splittable" type="checkbox" checked={splittable} onChange={(e) => setSplittable(e.target.checked)} />
          <label htmlFor="splittable" className="text-sm">{t('form.splittable')}</label>
        </div>
        <div className="col-span-2 rounded-md border border-gray-200 p-2">
          <div className="flex items-center gap-2">
            <input id="pw" type="checkbox" checked={pwEnabled} onChange={(e) => setPwEnabled(e.target.checked)} />
            <label htmlFor="pw" className="text-sm">{t('taskForm.preferredWindow')}</label>
          </div>
          {pwEnabled && (
            <div className="mt-2 flex items-center gap-2 text-sm">
              <select className="rounded-md border border-gray-300 px-2 py-1" value={pwWeekday} onChange={(e) => setPwWeekday(e.target.value)}>
                {WEEKDAY_ORDER.map((d) => (
                  <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>
                ))}
              </select>
              <input type="time" className="rounded-md border border-gray-300 px-2 py-1" value={pwStart} onChange={(e) => setPwStart(e.target.value)} />
              <span>–</span>
              <input type="time" className="rounded-md border border-gray-300 px-2 py-1" value={pwEnd} onChange={(e) => setPwEnd(e.target.value)} />
            </div>
          )}
        </div>
        <div className="col-span-2">
          <label className={labelCls}>{t('form.notes')}</label>
          <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="col-span-2 mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-4 py-1.5 text-sm hover:bg-gray-50">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={mutation.isPending} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
            {mutation.isPending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
