import { addDays, format, isSameDay, isSameMonth, isToday, parseISO, startOfMonth, startOfWeek } from 'date-fns'
import type { ScheduledBlock, Settings, Task } from '../../types'

const NEAR_CAP_RATIO = 0.8

interface MonthViewProps {
  month: Date
  blocks: ScheduledBlock[]
  tasks: Task[]
  settings: Settings
  onSelectDay: (day: Date) => void
  onCreateTask: (day: Date) => void
  onCreatePlan: (day: Date) => void
}

export function MonthView({
  month,
  blocks,
  tasks,
  settings,
  onSelectDay,
  onCreateTask,
  onCreatePlan,
}: MonthViewProps) {
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))

  return (
    <div>
      <div className="grid grid-cols-7 text-center text-xs text-gray-500">
        {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label) => (
          <div key={label} className="py-1">{label}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200">
        {cells.map((day) => {
          const dayBlocks = blocks
            .filter((b) => isSameDay(parseISO(b.startAt), day))
            .sort((a, b) => a.startAt.localeCompare(b.startAt))
          const plannedHours = dayBlocks.reduce(
            (sum, b) => sum + (parseISO(b.endAt).getTime() - parseISO(b.startAt).getTime()) / 3_600_000,
            0,
          )
          const dueCount = tasks.filter(
            (t) => t.status === 'active' && !!t.deadline && isSameDay(parseISO(t.deadline), day),
          ).length
          const overloaded = plannedHours > settings.dailyMaxPlannedHours
          const nearCap =
            !overloaded && plannedHours >= settings.dailyMaxPlannedHours * NEAR_CAP_RATIO
          const top = dayBlocks.slice(0, 2)
          return (
            <div
              key={day.toISOString()}
              role="button"
              tabIndex={0}
              onClick={() => onSelectDay(day)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelectDay(day)
              }}
              className={`group min-h-24 cursor-pointer bg-white p-1 text-left align-top hover:bg-blue-50 ${
                isSameMonth(day, month) ? '' : 'opacity-40'
              }`}
            >
              <div className="flex items-center gap-1 text-xs">
                <span
                  className={`font-medium ${isToday(day) ? 'rounded-full bg-blue-600 px-1.5 text-white' : ''}`}
                >
                  {format(day, 'd')}
                </span>
                {dayBlocks.length > 0 && (
                  <span className="text-gray-400">
                    {dayBlocks.length}块 {plannedHours.toFixed(0)}h
                  </span>
                )}
                {overloaded && (
                  <span
                    className="rounded bg-red-100 px-1 text-[10px] text-red-700"
                    title={`超过每日上限 ${settings.dailyMaxPlannedHours} 小时`}
                  >
                    +{(plannedHours - settings.dailyMaxPlannedHours).toFixed(1)}h
                  </span>
                )}
                {nearCap && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="接近每日上限" />
                )}
                <span className="ml-auto hidden gap-0.5 group-hover:flex">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onCreateTask(day)
                    }}
                    title="新建任务（截止日预填此日期）"
                    className="rounded bg-white px-1 text-[10px] text-gray-500 shadow hover:text-blue-600"
                  >
                    ＋任务
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onCreatePlan(day)
                    }}
                    title="新建计划（日期预填此日期）"
                    className="rounded bg-white px-1 text-[10px] text-gray-500 shadow hover:text-blue-600"
                  >
                    ＋计划
                  </button>
                </span>
              </div>
              {dueCount > 0 && (
                <div className="mt-0.5 inline-block rounded bg-rose-100 px-1 text-[10px] text-rose-700">
                  {dueCount} 个截止
                </div>
              )}
              {top.map((b) => (
                <div key={b.id} className="mt-0.5 truncate text-[10px] text-gray-600">
                  {format(parseISO(b.startAt), 'HH:mm')} {taskById.get(b.taskId)?.title ?? ''}
                </div>
              ))}
              {dayBlocks.length > top.length && (
                <div className="text-[10px] text-gray-400">+{dayBlocks.length - top.length} 更多</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
