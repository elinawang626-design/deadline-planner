import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { listTasks } from '../../api/tasks'
import { createPlan } from '../../api/plans'
import { useUI } from '../../store/ui'
import { Modal } from '../ui/Modal'
import { PRIORITY_LABELS } from '../../lib/labels'
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
      if (!date) throw new Error('请选择计划日期')
      const startAt = new Date(`${date}T${startTime}`)
      const endAt = new Date(`${date}T${endTime}`)
      if (!(startAt < endAt)) throw new Error('结束时间必须晚于开始时间')
      const payload: PlanCreate = {
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        notes: notes.trim() || undefined,
      }
      if (mode === 'existing') {
        if (!taskId) throw new Error('请选择一个任务')
        payload.taskId = taskId
      } else {
        const estimatedMinutes = Number(hours || 0) * 60 + Number(minutes || 0)
        if (!title.trim()) throw new Error('标题不能为空')
        if (estimatedMinutes <= 0) throw new Error('预计时长必须大于 0')
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
      pushToast('success', '计划已创建，其余日程已重排')
      for (const warning of result.warnings) {
        pushToast('error', warning.message)
      }
      onClose()
    },
    onError: (error: unknown) =>
      pushToast('error', error instanceof Error ? error.message : '保存失败'),
  })

  return (
    <Modal title="新建计划" onClose={onClose} wide>
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
            绑定现有任务
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
            创建新任务
          </label>
        </div>

        {mode === 'existing' ? (
          <div>
            <label className={labelCls}>任务 *</label>
            <select className={inputCls} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">请选择任务…</option>
              {activeTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {t.deadline ? `（截止 ${format(new Date(t.deadline), 'M/d HH:mm')}）` : '（无截止）'}
                </option>
              ))}
            </select>
            {activeTasks.length === 0 && (
              <p className="mt-1 text-xs text-gray-500">没有进行中的任务，请改为创建新任务。</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 rounded-md border border-gray-200 p-3">
            <div className="col-span-2">
              <label className={labelCls}>标题 *</label>
              <input autoFocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>截止日期（可选）</label>
              <input type="date" className={inputCls} value={deadlineDate} onChange={(e) => setDeadlineDate(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>截止时间</label>
              <input type="time" className={inputCls} value={deadlineTime} onChange={(e) => setDeadlineTime(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>预计总时长（小时 + 分钟）</label>
              <div className="flex gap-2">
                <input type="number" min="0" className={inputCls} value={hours} onChange={(e) => setHours(e.target.value)} />
                <input type="number" min="0" max="59" step="15" className={inputCls} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={labelCls}>优先级</label>
              <select className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>最小块时长（分钟，可选）</label>
              <input type="number" min="0" step="15" className={inputCls} value={minBlock} onChange={(e) => setMinBlock(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>最大块时长（分钟，可选）</label>
              <input type="number" min="0" step="15" className={inputCls} value={maxBlock} onChange={(e) => setMaxBlock(e.target.value)} />
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <input id="plan-splittable" type="checkbox" checked={splittable} onChange={(e) => setSplittable(e.target.checked)} />
              <label htmlFor="plan-splittable" className="text-sm">可拆分为多个时间块</label>
            </div>
            <p className="col-span-2 text-xs text-gray-500">
              预计总时长指整个任务；本次手动计划会计入已安排时长，自动调度只补剩余部分。
            </p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>日期 *</label>
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>开始时间 *</label>
            <input type="time" className={inputCls} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>结束时间 *</label>
            <input type="time" className={inputCls} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={labelCls}>备注</label>
          <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <p className="text-xs text-gray-500">
          手动计划保存后锁定（重排时保留）；允许重叠、超出可用时间或超过截止时间，但会返回警告。
        </p>
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-4 py-1.5 text-sm hover:bg-gray-50">
            取消
          </button>
          <button type="submit" disabled={mutation.isPending} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
            {mutation.isPending ? '保存中…' : '保存计划'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
