import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { addMonths, format, parseISO } from 'date-fns'
import { listTasks } from '../api/tasks'
import { listBlocks } from '../api/schedule'
import { getSettings } from '../api/availability'
import { useUI } from '../store/ui'
import { MonthView } from '../components/calendar/MonthView'
import { TaskForm } from '../components/tasks/TaskForm'
import { PlanForm } from '../components/plans/PlanForm'

const navBtn = 'rounded-md border border-gray-300 px-2 py-1 text-sm hover:bg-gray-50'

export default function MonthPage() {
  const navigate = useNavigate()
  const currentDate = useUI((s) => s.currentDate)
  const setCurrentDate = useUI((s) => s.setCurrentDate)
  const month = parseISO(currentDate)
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: listTasks })
  const { data: blocks = [] } = useQuery({ queryKey: ['blocks'], queryFn: () => listBlocks() })
  const { data: settings = { dailyMaxPlannedHours: 6 } } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })
  const [taskDate, setTaskDate] = useState<string | null>(null)
  const [planDate, setPlanDate] = useState<string | null>(null)

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => setCurrentDate(format(addMonths(month, -1), 'yyyy-MM-dd'))} className={navBtn} aria-label="上个月">←</button>
        <button onClick={() => setCurrentDate(format(new Date(), 'yyyy-MM-dd'))} className={navBtn}>本月</button>
        <button onClick={() => setCurrentDate(format(addMonths(month, 1), 'yyyy-MM-dd'))} className={navBtn} aria-label="下个月">→</button>
        <h2 className="ml-2 text-lg font-semibold">{format(month, 'yyyy年M月')}</h2>
      </div>
      <MonthView
        month={month}
        blocks={blocks}
        tasks={tasks}
        settings={settings}
        onSelectDay={(day) => {
          setCurrentDate(format(day, 'yyyy-MM-dd'))
          navigate('/day')
        }}
        onCreateTask={(day) => setTaskDate(format(day, 'yyyy-MM-dd'))}
        onCreatePlan={(day) => setPlanDate(format(day, 'yyyy-MM-dd'))}
      />
      {taskDate && <TaskForm initialDeadlineDate={taskDate} onClose={() => setTaskDate(null)} />}
      {planDate && <PlanForm defaultDate={planDate} onClose={() => setPlanDate(null)} />}
    </div>
  )
}
