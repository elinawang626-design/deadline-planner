import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { listTasks } from '../api/tasks'
import { listChecklist, listEstimates, listWorkLogs } from '../api/track'
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS, fmtMinutes, priorityColor } from '../lib/labels'
import { ChecklistSection } from '../components/track/ChecklistSection'
import { WorkLogSection } from '../components/track/WorkLogSection'
import { AttachmentSection } from '../components/track/AttachmentSection'
import { EstimateSection } from '../components/track/EstimateSection'
import { CareerSection } from '../components/track/CareerSection'

export default function TaskDetailPage() {
  const { taskId = '' } = useParams()
  const { data: tasks = [], isLoading } = useQuery({ queryKey: ['tasks'], queryFn: listTasks })
  const task = tasks.find((t) => t.id === taskId)

  const { data: worklogs = [] } = useQuery({
    queryKey: ['worklogs', taskId],
    queryFn: () => listWorkLogs(taskId),
    enabled: !!task,
  })
  const { data: checklist = [] } = useQuery({
    queryKey: ['checklist', taskId],
    queryFn: () => listChecklist(taskId),
    enabled: !!task,
  })
  const { data: estimates = [] } = useQuery({
    queryKey: ['estimates', taskId],
    queryFn: () => listEstimates(taskId),
    enabled: !!task,
  })

  if (isLoading) return <p className="text-sm text-gray-400">加载中…</p>
  if (!task) {
    return (
      <div className="mx-auto max-w-3xl">
        <p className="text-sm text-gray-500">任务不存在或已删除。</p>
        <Link to="/tasks" className="text-sm text-blue-600 hover:underline">
          ← 返回任务列表
        </Link>
      </div>
    )
  }

  const actual = worklogs.reduce((sum, w) => sum + w.durationMinutes, 0)
  const remaining = Math.max(0, task.estimatedMinutes - actual)
  const done = checklist.filter((i) => i.completed).length
  const latestEstimate = estimates[0]
  const overdue = task.status === 'active' && parseISO(task.deadline) < new Date()

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <Link to="/tasks" className="text-xs text-blue-600 hover:underline">
          ← 返回任务列表
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`rounded border px-1.5 py-0.5 text-xs ${priorityColor[task.priority]}`}>
            {PRIORITY_LABELS[task.priority]}
          </span>
          <h2 className="text-lg font-semibold">{task.title}</h2>
          <span className="text-xs text-gray-400">{TYPE_LABELS[task.type]}</span>
          <span className="text-xs text-gray-400">{STATUS_LABELS[task.status]}</span>
        </div>
        {task.description && <p className="mt-1 text-sm text-gray-600">{task.description}</p>}
        <p className={`mt-1 text-xs ${overdue ? 'font-medium text-red-600' : 'text-gray-500'}`}>
          截止 {format(parseISO(task.deadline), 'yyyy/M/d HH:mm')}
          {overdue && '（已逾期）'}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-gray-400">当前预计</p>
          <p className="font-medium">{fmtMinutes(task.estimatedMinutes)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">AI 估时区间</p>
          <p className="font-medium">
            {latestEstimate
              ? `${fmtMinutes(latestEstimate.optimisticMinutes)} ~ ${fmtMinutes(latestEstimate.pessimisticMinutes)}`
              : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400">实际投入</p>
          <p className="font-medium">{fmtMinutes(actual)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">
            {checklist.length > 0 ? '检查项进度' : '预计剩余'}
          </p>
          <p className="font-medium">
            {checklist.length > 0
              ? `${done}/${checklist.length}（${Math.round((done / checklist.length) * 100)}%）`
              : fmtMinutes(remaining)}
          </p>
        </div>
      </section>

      <ChecklistSection taskId={task.id} />
      <WorkLogSection taskId={task.id} />
      <AttachmentSection taskId={task.id} />
      <EstimateSection taskId={task.id} />
      <CareerSection task={task} />
    </div>
  )
}
