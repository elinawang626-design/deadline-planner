import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { listTasks } from '../api/tasks'
import { listChecklist, listEstimates, listWorkLogs } from '../api/track'
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS, fmtMinutes, priorityColor } from '../lib/labels'
import { useT } from '../i18n'
import { ChecklistSection } from '../components/track/ChecklistSection'
import { WorkLogSection } from '../components/track/WorkLogSection'
import { AttachmentSection } from '../components/track/AttachmentSection'
import { EstimateSection } from '../components/track/EstimateSection'
import { CareerSection } from '../components/track/CareerSection'

export default function TaskDetailPage() {
  const t = useT()
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

  if (isLoading) return <p className="text-sm text-gray-400">{t('common.loading')}</p>
  if (!task) {
    return (
      <div className="mx-auto max-w-3xl">
        <p className="text-sm text-gray-500">{t('taskDetail.notFound')}</p>
        <Link to="/tasks" className="text-sm text-blue-600 hover:underline">
          {t('taskDetail.back')}
        </Link>
      </div>
    )
  }

  const actual = worklogs.reduce((sum, w) => sum + w.durationMinutes, 0)
  const remaining = Math.max(0, task.estimatedMinutes - actual)
  const done = checklist.filter((i) => i.completed).length
  const latestEstimate = estimates[0]
  const overdue =
    task.status === 'active' && !!task.deadline && parseISO(task.deadline) < new Date()

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <Link to="/tasks" className="text-xs text-blue-600 hover:underline">
          {t('taskDetail.back')}
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
          {task.deadline
            ? t('taskDetail.deadline', { time: format(parseISO(task.deadline), 'yyyy/M/d HH:mm') })
            : t('taskDetail.noDeadline')}
          {overdue && t('taskDetail.overdueTag')}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-gray-400">{t('taskDetail.currentEstimate')}</p>
          <p className="font-medium">{fmtMinutes(task.estimatedMinutes)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">{t('taskDetail.aiRange')}</p>
          <p className="font-medium">
            {latestEstimate
              ? `${fmtMinutes(latestEstimate.optimisticMinutes)} ~ ${fmtMinutes(latestEstimate.pessimisticMinutes)}`
              : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400">{t('taskDetail.actual')}</p>
          <p className="font-medium">{fmtMinutes(actual)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">
            {checklist.length > 0 ? t('taskDetail.checklistProgress') : t('taskDetail.estimatedRemaining')}
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
