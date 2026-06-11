import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { listTasks } from '../api/tasks'
import { listBlocks } from '../api/schedule'
import { TaskForm } from '../components/tasks/TaskForm'
import { TaskList } from '../components/tasks/TaskList'
import type { Task } from '../types'

export default function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: listTasks })
  const { data: blocks = [] } = useQuery({ queryKey: ['blocks'], queryFn: () => listBlocks() })
  const [editing, setEditing] = useState<Task | null>(null)
  const creating = searchParams.get('new') === '1'

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">任务</h2>
        <button
          onClick={() => setSearchParams({ new: '1' })}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
        >
          ＋ 新建任务
        </button>
      </div>
      <TaskList tasks={tasks} blocks={blocks} onEdit={setEditing} />
      {creating && <TaskForm onClose={() => setSearchParams({})} />}
      {editing && <TaskForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
