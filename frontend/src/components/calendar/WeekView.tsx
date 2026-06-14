import { addDays, format, isSameDay, isToday, parseISO } from 'date-fns'
import { WEEKDAY_LABELS, priorityColor } from '../../lib/labels'
import { useT } from '../../i18n'
import type { FixedEvent, ScheduledBlock, Settings, Task } from '../../types'

const NEAR_CAP_RATIO = 0.8

interface WeekViewProps {
  weekStart: Date
  blocks: ScheduledBlock[]
  tasks: Task[]
  fixedEvents: FixedEvent[]
  settings: Settings
  onSelectDay: (day: Date) => void
  onBlockClick: (block: ScheduledBlock) => void
  onCreateTask: (day: Date) => void
  onCreatePlan: (day: Date) => void
}

export function WeekView({
  weekStart,
  blocks,
  tasks,
  fixedEvents,
  settings,
  onSelectDay,
  onBlockClick,
  onCreateTask,
  onCreatePlan,
}: WeekViewProps) {
  const t = useT()
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  return (
    <div className="grid grid-cols-7 gap-2">
      {days.map((day) => {
        const dayBlocks = blocks
          .filter((b) => isSameDay(parseISO(b.startAt), day))
          .sort((a, b) => a.startAt.localeCompare(b.startAt))
        const plannedHours = dayBlocks.reduce(
          (sum, b) => sum + (parseISO(b.endAt).getTime() - parseISO(b.startAt).getTime()) / 3_600_000,
          0,
        )
        const overloaded = plannedHours > settings.dailyMaxPlannedHours
        const nearCap =
          !overloaded && plannedHours >= settings.dailyMaxPlannedHours * NEAR_CAP_RATIO
        const due = tasks.filter(
          (task) => task.status === 'active' && !!task.deadline && isSameDay(parseISO(task.deadline), day),
        )
        const events = fixedEvents.filter((e) => isSameDay(parseISO(e.startAt), day))
        return (
          <div
            key={day.toISOString()}
            className={`flex min-h-48 flex-col rounded-lg border bg-white p-2 ${
              isToday(day) ? 'border-blue-400' : 'border-gray-200'
            }`}
          >
            <div className="mb-1 flex items-center">
              <button onClick={() => onSelectDay(day)} className="text-left hover:text-blue-600">
                <span className="text-xs text-gray-500">{WEEKDAY_LABELS[day.getDay()]}</span>
                <span className="ml-1 text-sm font-semibold">{format(day, 'M/d')}</span>
              </button>
              <button
                onClick={() => onCreateTask(day)}
                title={t('cal.newTaskTitle')}
                className="ml-auto rounded px-1 text-xs text-gray-400 hover:bg-blue-50 hover:text-blue-600"
              >
                {t('cal.addTask')}
              </button>
              <button
                onClick={() => onCreatePlan(day)}
                title={t('cal.newPlanTitle')}
                className="rounded px-1 text-xs text-gray-400 hover:bg-blue-50 hover:text-blue-600"
              >
                {t('cal.addPlan')}
              </button>
            </div>
            <div className="mb-1 flex items-center gap-1 text-xs">
              <span className="text-gray-500">{plannedHours.toFixed(1)}h</span>
              {overloaded && (
                <span className="rounded bg-red-100 px-1 text-red-700">
                  {t('weekView.overload', { hours: (plannedHours - settings.dailyMaxPlannedHours).toFixed(1) })}
                </span>
              )}
              {nearCap && (
                <span className="rounded bg-amber-100 px-1 text-amber-700">{t('weekView.nearCap')}</span>
              )}
            </div>
            {due.map((task) => (
              <div key={task.id} className="mb-1 truncate rounded bg-rose-50 px-1 text-xs text-rose-700" title={task.title}>
                {t('weekView.due', { title: task.title })}
              </div>
            ))}
            {events.map((e) => (
              <div key={e.id} className="mb-1 truncate rounded bg-gray-100 px-1 text-xs text-gray-600" title={e.title}>
                {format(parseISO(e.startAt), 'HH:mm')} {e.title}
              </div>
            ))}
            {dayBlocks.map((b) => {
              const task = taskById.get(b.taskId)
              return (
                <button
                  key={b.id}
                  onClick={() => onBlockClick(b)}
                  className={`mb-1 truncate rounded border px-1 text-left text-xs ${priorityColor[task?.priority ?? 'medium']} ${b.done ? 'line-through opacity-50' : ''}`}
                  title={task?.title}
                >
                  {format(parseISO(b.startAt), 'HH:mm')} {task?.title ?? b.taskId}
                  {b.locked ? ' 🔒' : ''}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
