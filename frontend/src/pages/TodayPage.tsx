import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, isSameDay, parseISO } from 'date-fns'
import { listTasks } from '../api/tasks'
import { listBlocks, listFixedEvents } from '../api/schedule'
import { useUI } from '../store/ui'
import { DayView } from '../components/calendar/DayView'
import { BlockEditModal } from '../components/schedule/BlockEditModal'
import { TaskForm } from '../components/tasks/TaskForm'
import { PlanForm } from '../components/plans/PlanForm'
import { WEEKDAY_LABELS } from '../lib/labels'
import type { ScheduledBlock } from '../types'

const actionBtn = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50'

export default function TodayPage() {
  const today = new Date()
  const todayStr = format(today, 'yyyy-MM-dd')
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: listTasks })
  const { data: blocks = [] } = useQuery({ queryKey: ['blocks'], queryFn: () => listBlocks() })
  const { data: fixedEvents = [] } = useQuery({
    queryKey: ['fixed-events'],
    queryFn: listFixedEvents,
  })
  const lastSummary = useUI((s) => s.lastSummary)
  const [editing, setEditing] = useState<ScheduledBlock | null>(null)
  const [creatingTask, setCreatingTask] = useState(false)
  const [creatingPlan, setCreatingPlan] = useState(false)

  const todayBlocks = blocks.filter((b) => isSameDay(parseISO(b.startAt), today))
  const plannedHours = todayBlocks.reduce(
    (sum, b) => sum + (parseISO(b.endAt).getTime() - parseISO(b.startAt).getTime()) / 3_600_000,
    0,
  )
  const doneCount = todayBlocks.filter((b) => b.done).length

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold">
          {format(today, 'yyyy年M月d日')} {WEEKDAY_LABELS[today.getDay()]}
        </h2>
        <button onClick={() => setCreatingTask(true)} className={`ml-auto ${actionBtn}`}>
          ＋ 新建任务
        </button>
        <button onClick={() => setCreatingPlan(true)} className={actionBtn}>
          ＋ 新建计划
        </button>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        今日 {todayBlocks.length} 个时间块 / {plannedHours.toFixed(1)} 小时
        {todayBlocks.length > 0 && `，已完成 ${doneCount} 块`}
      </p>
      {lastSummary &&
        (lastSummary.warnings.length > 0 || lastSummary.totalUnscheduledMinutes > 0) && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <p className="mb-1 font-medium">上次调度的结果</p>
            {lastSummary.totalUnscheduledMinutes > 0 && (
              <p className="mb-1">共 {lastSummary.totalUnscheduledMinutes} 分钟未能安排。</p>
            )}
            <ul className="list-inside list-disc">
              {lastSummary.warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          </div>
        )}
      <DayView
        date={today}
        blocks={blocks}
        tasks={tasks}
        fixedEvents={fixedEvents}
        onBlockClick={setEditing}
      />
      {editing && (
        <BlockEditModal
          block={editing}
          task={tasks.find((t) => t.id === editing.taskId)}
          onClose={() => setEditing(null)}
        />
      )}
      {creatingTask && (
        <TaskForm initialDeadlineDate={todayStr} onClose={() => setCreatingTask(false)} />
      )}
      {creatingPlan && <PlanForm defaultDate={todayStr} onClose={() => setCreatingPlan(false)} />}
    </div>
  )
}
