import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { deleteBlock, regenerateSchedule, updateBlock } from '../../api/schedule'
import { useUI } from '../../store/ui'
import { Modal } from '../ui/Modal'
import type { BlockSource, ScheduledBlock, Task } from '../../types'

const inputCls =
  'w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none'
const labelCls = 'mb-1 block text-xs font-medium text-gray-600'

interface BlockEditModalProps {
  block: ScheduledBlock
  task?: Task
  onClose: () => void
}

export function BlockEditModal({ block, task, onClose }: BlockEditModalProps) {
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const setLastSummary = useUI((s) => s.setLastSummary)

  const [startAt, setStartAt] = useState(format(parseISO(block.startAt), "yyyy-MM-dd'T'HH:mm"))
  const [endAt, setEndAt] = useState(format(parseISO(block.endAt), "yyyy-MM-dd'T'HH:mm"))
  const [locked, setLocked] = useState(block.locked)
  const [source, setSource] = useState<BlockSource>(block.source)
  const [notes, setNotes] = useState(block.notes ?? '')

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['blocks'] })
    queryClient.invalidateQueries({ queryKey: ['tasks'] })
  }

  const save = useMutation({
    mutationFn: async () => {
      const start = new Date(startAt)
      const end = new Date(endAt)
      if (!(start < end)) throw new Error('结束时间必须晚于开始时间')
      const timeChanged =
        start.toISOString() !== block.startAt || end.toISOString() !== block.endAt
      // a manually moved block becomes manual + locked so regeneration keeps it
      await updateBlock(block.id, {
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        locked: timeChanged ? true : locked,
        source: timeChanged ? 'manual' : source,
        notes: notes || undefined,
      })
      if (timeChanged && window.confirm('该时间块已锁定。是否围绕它重新生成其余日程？')) {
        setLastSummary(await regenerateSchedule())
      }
    },
    onSuccess: () => {
      invalidate()
      pushToast('success', '时间块已更新')
      onClose()
    },
    onError: (error: unknown) =>
      pushToast('error', error instanceof Error ? error.message : '更新失败'),
  })

  const toggleDone = useMutation({
    mutationFn: () => updateBlock(block.id, { done: !block.done }),
    onSuccess: () => {
      invalidate()
      pushToast('success', block.done ? '已取消完成标记' : '已标记完成')
      onClose()
    },
  })

  const remove = useMutation({
    mutationFn: () => deleteBlock(block.id),
    onSuccess: () => {
      invalidate()
      pushToast('success', '时间块已删除')
      onClose()
    },
  })

  return (
    <Modal title={task ? `时间块：${task.title}` : '时间块'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
        className="flex flex-col gap-3"
      >
        <div>
          <label className={labelCls}>开始时间</label>
          <input type="datetime-local" className={inputCls} value={startAt} onChange={(e) => setStartAt(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>结束时间</label>
          <input type="datetime-local" className={inputCls} value={endAt} onChange={(e) => setEndAt(e.target.value)} />
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
            锁定（重排时保留）
          </label>
          <label className="flex items-center gap-2 text-sm">
            来源
            <select
              className="rounded-md border border-gray-300 px-2 py-1 text-sm"
              value={source}
              onChange={(e) => setSource(e.target.value as BlockSource)}
            >
              <option value="auto">自动</option>
              <option value="manual">手动</option>
            </select>
          </label>
        </div>
        <div>
          <label className={labelCls}>备注</label>
          <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => remove.mutate()}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
          >
            删除
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => toggleDone.mutate()}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              {block.done ? '取消完成' : '标记完成'}
            </button>
            <button
              type="submit"
              disabled={save.isPending}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              保存
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
