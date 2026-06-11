import { addDays, format, isSameDay, isToday, parseISO } from 'date-fns'
import { WEEKDAY_LABELS, priorityColor } from '../../lib/labels'
import type { FixedEvent, ScheduledBlock, Settings, Task } from '../../types'

interface WeekViewProps {
  weekStart: Date
  blocks: ScheduledBlock[]
  tasks: Task[]
  fixedEvents: FixedEvent[]
  settings: Settings
  onSelectDay: (day: Date) => void
  onBlockClick: (block: ScheduledBlock) => void
  onAddTask: () => void
}

export function WeekView({
  weekStart,
  blocks,
  tasks,
  fixedEvents,
  settings,
  onSelectDay,
  onBlockClick,
  onAddTask,
}: WeekViewProps) {
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  return (
    <div>
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
          const due = tasks.filter(
            (t) => t.status === 'active' && isSameDay(parseISO(t.deadline), day),
          )
          const events = fixedEvents.filter((e) => isSameDay(parseISO(e.startAt), day))
          return (
            <div
              key={day.toISOString()}
              className={`flex min-h-48 flex-col rounded-lg border bg-white p-2 ${
                isToday(day) ? 'border-blue-400' : 'border-gray-200'
              }`}
            >
              <button onClick={() => onSelectDay(day)} className="mb-1 text-left hover:text-blue-600">
                <span className="text-xs text-gray-500">{WEEKDAY_LABELS[day.getDay()]}</span>
                <span className="ml-1 text-sm font-semibold">{format(day, 'M/d')}</span>
              </button>
              <div className="mb-1 flex items-center gap-1 text-xs">
                <span className="text-gray-500">{plannedHours.toFixed(1)}h</span>
                {overloaded && <span className="rounded bg-red-100 px-1 text-red-700">超载</span>}
              </div>
              {due.map((t) => (
                <div key={t.id} className="mb-1 truncate rounded bg-rose-50 px-1 text-xs text-rose-700" title={t.title}>
                  📌 截止：{t.title}
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
      <button
        onClick={onAddTask}
        className="mt-3 rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600"
      >
        ＋ 添加任务
      </button>
    </div>
  )
}
