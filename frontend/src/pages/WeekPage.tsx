import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { addDays, format, parseISO, startOfWeek } from 'date-fns'
import { listTasks } from '../api/tasks'
import { listBlocks, listFixedEvents } from '../api/schedule'
import { getSettings } from '../api/availability'
import { useUI } from '../store/ui'
import { WeekView } from '../components/calendar/WeekView'
import { BlockEditModal } from '../components/schedule/BlockEditModal'
import { TaskForm } from '../components/tasks/TaskForm'
import { PlanForm } from '../components/plans/PlanForm'
import type { ScheduledBlock } from '../types'

const navBtn = 'rounded-md border border-gray-300 px-2 py-1 text-sm hover:bg-gray-50'

export default function WeekPage() {
  const navigate = useNavigate()
  const currentDate = useUI((s) => s.currentDate)
  const setCurrentDate = useUI((s) => s.setCurrentDate)
  const weekStart = startOfWeek(parseISO(currentDate), { weekStartsOn: 1 })
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: listTasks })
  const { data: blocks = [] } = useQuery({ queryKey: ['blocks'], queryFn: () => listBlocks() })
  const { data: fixedEvents = [] } = useQuery({
    queryKey: ['fixed-events'],
    queryFn: listFixedEvents,
  })
  const { data: settings = { dailyMaxPlannedHours: 6 } } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })
  const [editing, setEditing] = useState<ScheduledBlock | null>(null)
  const [taskDate, setTaskDate] = useState<string | null>(null)
  const [planDate, setPlanDate] = useState<string | null>(null)

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => setCurrentDate(format(addDays(weekStart, -7), 'yyyy-MM-dd'))} className={navBtn} aria-label="上一周">←</button>
        <button onClick={() => setCurrentDate(format(new Date(), 'yyyy-MM-dd'))} className={navBtn}>本周</button>
        <button onClick={() => setCurrentDate(format(addDays(weekStart, 7), 'yyyy-MM-dd'))} className={navBtn} aria-label="下一周">→</button>
        <h2 className="ml-2 text-lg font-semibold">
          {format(weekStart, 'M/d')} – {format(addDays(weekStart, 6), 'M/d')}
        </h2>
      </div>
      <WeekView
        weekStart={weekStart}
        blocks={blocks}
        tasks={tasks}
        fixedEvents={fixedEvents}
        settings={settings}
        onSelectDay={(day) => {
          setCurrentDate(format(day, 'yyyy-MM-dd'))
          navigate('/day')
        }}
        onBlockClick={setEditing}
        onCreateTask={(day) => setTaskDate(format(day, 'yyyy-MM-dd'))}
        onCreatePlan={(day) => setPlanDate(format(day, 'yyyy-MM-dd'))}
      />
      {editing && (
        <BlockEditModal
          block={editing}
          task={tasks.find((t) => t.id === editing.taskId)}
          onClose={() => setEditing(null)}
        />
      )}
      {taskDate && <TaskForm initialDeadlineDate={taskDate} onClose={() => setTaskDate(null)} />}
      {planDate && <PlanForm defaultDate={planDate} onClose={() => setPlanDate(null)} />}
    </div>
  )
}
