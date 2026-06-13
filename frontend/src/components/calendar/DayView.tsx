import { format, isSameDay, parseISO } from 'date-fns'
import { PRIORITY_LABELS, priorityColor } from '../../lib/labels'
import type { FixedEvent, ScheduledBlock, Task } from '../../types'

const START_HOUR = 6
const END_HOUR = 24
const HOUR_PX = 48

interface DayViewProps {
  date: Date
  blocks: ScheduledBlock[]
  tasks: Task[]
  fixedEvents: FixedEvent[]
  onBlockClick: (block: ScheduledBlock) => void
}

export function DayView({ date, blocks, tasks, fixedEvents, onBlockClick }: DayViewProps) {
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const dayBlocks = blocks.filter((b) => isSameDay(parseISO(b.startAt), date))
  const dayEvents = fixedEvents.filter((e) => isSameDay(parseISO(e.startAt), date))
  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i)

  const position = (startIso: string, endIso: string) => {
    const start = parseISO(startIso)
    const end = parseISO(endIso)
    const startH = Math.max(start.getHours() + start.getMinutes() / 60, START_HOUR)
    const endH = isSameDay(end, date)
      ? Math.min(end.getHours() + end.getMinutes() / 60, END_HOUR)
      : END_HOUR
    return {
      top: (startH - START_HOUR) * HOUR_PX,
      height: Math.max((endH - startH) * HOUR_PX - 2, 18),
    }
  }

  return (
    <div className="flex rounded-lg border border-gray-200 bg-white">
      <div className="w-14 shrink-0 pt-0">
        {hours.map((h) => (
          <div key={h} className="pr-2 text-right text-xs text-gray-400" style={{ height: HOUR_PX }}>
            {String(h).padStart(2, '0')}:00
          </div>
        ))}
      </div>
      <div className="relative flex-1 border-l border-gray-100" style={{ height: hours.length * HOUR_PX }}>
        {hours.map((h, i) => (
          <div key={h} className="absolute inset-x-0 border-t border-gray-100" style={{ top: i * HOUR_PX }} />
        ))}
        {dayEvents.map((event) => {
          const p = position(event.startAt, event.endAt)
          return (
            <div
              key={event.id}
              className="absolute inset-x-1 overflow-hidden rounded-md border border-gray-300 bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
              style={p}
            >
              <span className="font-medium">{event.title}</span>
              <span className="ml-1">
                {format(parseISO(event.startAt), 'HH:mm')}–{format(parseISO(event.endAt), 'HH:mm')}
              </span>
              <span className="ml-1 text-gray-400">固定事件</span>
            </div>
          )
        })}
        {dayBlocks.map((block) => {
          const task = taskById.get(block.taskId)
          const p = position(block.startAt, block.endAt)
          const overDeadline = task?.deadline
            ? parseISO(task.deadline) < parseISO(block.endAt)
            : false
          return (
            <button
              key={block.id}
              onClick={() => onBlockClick(block)}
              className={`absolute inset-x-1 overflow-hidden rounded-md border px-2 py-0.5 text-left text-xs hover:brightness-95 ${priorityColor[task?.priority ?? 'medium']} ${block.done ? 'line-through opacity-50' : ''}`}
              style={p}
            >
              <span className="font-medium">{task?.title ?? block.taskId}</span>
              <span className="ml-1">
                {format(parseISO(block.startAt), 'HH:mm')}–{format(parseISO(block.endAt), 'HH:mm')}
              </span>
              {task && <span className="ml-1">{PRIORITY_LABELS[task.priority]}</span>}
              {block.locked && <span className="ml-1" title="已锁定">🔒</span>}
              {block.source === 'manual' && (
                <span className="ml-1 rounded bg-white/70 px-1">手动</span>
              )}
              {overDeadline && <span className="ml-1" title="超过截止时间">⚠️</span>}
            </button>
          )
        })}
        {dayBlocks.length === 0 && dayEvents.length === 0 && (
          <p className="absolute inset-x-0 top-24 text-center text-sm text-gray-400">
            这一天还没有安排。新建任务或点击右上角「重新生成日程」。
          </p>
        )}
      </div>
    </div>
  )
}
