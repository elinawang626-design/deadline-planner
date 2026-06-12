import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { addDays, format, parseISO } from 'date-fns'
import { listTasks } from '../api/tasks'
import { listBlocks, listFixedEvents } from '../api/schedule'
import { useUI } from '../store/ui'
import { DayView } from '../components/calendar/DayView'
import { BlockEditModal } from '../components/schedule/BlockEditModal'
import { TaskForm } from '../components/tasks/TaskForm'
import { PlanForm } from '../components/plans/PlanForm'
import { WEEKDAY_LABELS } from '../lib/labels'
import type { ScheduledBlock } from '../types'

const navBtn = 'rounded-md border border-gray-300 px-2 py-1 text-sm hover:bg-gray-50'

export default function DayPage() {
  const currentDate = useUI((s) => s.currentDate)
  const setCurrentDate = useUI((s) => s.setCurrentDate)
  const date = parseISO(currentDate)
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: listTasks })
  const { data: blocks = [] } = useQuery({ queryKey: ['blocks'], queryFn: () => listBlocks() })
  const { data: fixedEvents = [] } = useQuery({
    queryKey: ['fixed-events'],
    queryFn: listFixedEvents,
  })
  const [editing, setEditing] = useState<ScheduledBlock | null>(null)
  const [creatingTask, setCreatingTask] = useState(false)
  const [creatingPlan, setCreatingPlan] = useState(false)

  const shift = (days: number) => setCurrentDate(format(addDays(date, days), 'yyyy-MM-dd'))

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => shift(-1)} className={navBtn} aria-label="前一天">←</button>
        <button onClick={() => setCurrentDate(format(new Date(), 'yyyy-MM-dd'))} className={navBtn}>
          今天
        </button>
        <button onClick={() => shift(1)} className={navBtn} aria-label="后一天">→</button>
        <h2 className="ml-2 text-lg font-semibold">
          {format(date, 'yyyy年M月d日')} {WEEKDAY_LABELS[date.getDay()]}
        </h2>
        <button
          onClick={() => setCreatingTask(true)}
          className="ml-auto rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ＋ 新建任务
        </button>
        <button
          onClick={() => setCreatingPlan(true)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ＋ 新建计划
        </button>
      </div>
      <DayView
        date={date}
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
        <TaskForm initialDeadlineDate={currentDate} onClose={() => setCreatingTask(false)} />
      )}
      {creatingPlan && (
        <PlanForm defaultDate={currentDate} onClose={() => setCreatingPlan(false)} />
      )}
    </div>
  )
}
