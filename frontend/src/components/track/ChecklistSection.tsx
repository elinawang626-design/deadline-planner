import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createChecklistItem,
  deleteChecklistItem,
  listChecklist,
  updateChecklistItem,
} from '../../api/track'
import { useUI } from '../../store/ui'

export function ChecklistSection({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const [title, setTitle] = useState('')
  const { data: items = [] } = useQuery({
    queryKey: ['checklist', taskId],
    queryFn: () => listChecklist(taskId),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['checklist', taskId] })
    queryClient.invalidateQueries({ queryKey: ['tracking-summary'] })
  }
  const onError = (error: unknown) =>
    pushToast('error', error instanceof Error ? error.message : '操作失败')

  const create = useMutation({
    mutationFn: (value: string) => createChecklistItem(taskId, value),
    onSuccess: () => {
      setTitle('')
      invalidate()
    },
    onError,
  })
  const toggle = useMutation({
    mutationFn: ({ id, completed }: { id: string; completed: boolean }) =>
      updateChecklistItem(taskId, id, { completed }),
    onSuccess: invalidate,
    onError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteChecklistItem(taskId, id),
    onSuccess: invalidate,
    onError,
  })

  const done = items.filter((i) => i.completed).length

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        检查项
        {items.length > 0 && (
          <span className="text-xs font-normal text-gray-500">
            {done}/{items.length}（{Math.round((done / items.length) * 100)}%）
          </span>
        )}
      </h3>
      {items.length === 0 && (
        <p className="mb-2 text-xs text-gray-400">还没有检查项；任务进度将按检查项完成数自动计算。</p>
      )}
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={item.completed}
              onChange={(e) => toggle.mutate({ id: item.id, completed: e.target.checked })}
            />
            <span className={item.completed ? 'text-gray-400 line-through' : ''}>
              {item.title}
            </span>
            <button
              onClick={() => remove.mutate(item.id)}
              className="ml-auto text-xs text-red-500 hover:underline"
            >
              删除
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim()) create.mutate(title.trim())
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新增检查项…"
          className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={!title.trim() || create.isPending}
          className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          添加
        </button>
      </form>
    </section>
  )
}
