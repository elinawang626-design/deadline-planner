import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, isSameDay, parseISO } from 'date-fns'
import { listTasks } from '../api/tasks'
import { listBlocks, listFixedEvents } from '../api/schedule'
import { useUI } from '../store/ui'
import { DayView } from '../components/calendar/DayView'
import { BlockEditModal } from '../components/schedule/BlockEditModal'
import { WEEKDAY_LABELS } from '../lib/labels'
import type { ScheduledBlock } from '../types'

export default function TodayPage() {
  const today = new Date()
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: listTasks })
  const { data: blocks = [] } = useQuery({ queryKey: ['blocks'], queryFn: () => listBlocks() })
  const { data: fixedEvents = [] } = useQuery({
    queryKey: ['fixed-events'],
    queryFn: listFixedEvents,
  })
  const lastSummary = useUI((s) => s.lastSummary)
  const [editing, setEditing] = useState<ScheduledBlock | null>(null)

  const todayBlocks = blocks.filter((b) => isSameDay(parseISO(b.startAt), today))
  const plannedHours = todayBlocks.reduce(
    (sum, b) => sum + (parseISO(b.endAt).getTime() - parseISO(b.startAt).getTime()) / 3_600_000,
    0,
  )
  const doneCount = todayBlocks.filter((b) => b.done).length

  return (
    <div className="mx-auto max-w-4xl">
      <h2 className="text-xl font-semibold">
        {format(today, 'yyyy年M月d日')} {WEEKDAY_LABELS[today.getDay()]}
      </h2>
      <p className="mb-4 text-sm text-gray-500">
        今日 {todayBlocks.length} 个时间块 / {plannedHours.toFixed(1)} 小时
        {todayBlocks.length > 0 && `，已完成 ${doneCount} 块`}
      </p>
      {lastSummary && lastSummary.warnings.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="mb-1 font-medium">上次调度的警告</p>
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
    </div>
  )
}
