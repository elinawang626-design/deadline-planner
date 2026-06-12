import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { createWorkLog, deleteWorkLog, listWorkLogs } from '../../api/track'
import { useUI } from '../../store/ui'
import { fmtMinutes } from '../../lib/labels'

export function WorkLogSection({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const [workedAt, setWorkedAt] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [minutes, setMinutes] = useState('30')
  const [summary, setSummary] = useState('')
  const [challenge, setChallenge] = useState('')
  const [result, setResult] = useState('')

  const { data: logs = [] } = useQuery({
    queryKey: ['worklogs', taskId],
    queryFn: () => listWorkLogs(taskId),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['worklogs', taskId] })
    queryClient.invalidateQueries({ queryKey: ['tracking-summary'] })
  }
  const onError = (error: unknown) =>
    pushToast('error', error instanceof Error ? error.message : '操作失败')

  const create = useMutation({
    mutationFn: () =>
      createWorkLog(taskId, {
        workedAt,
        durationMinutes: Number(minutes),
        summary: summary.trim(),
        challenge: challenge.trim() || undefined,
        result: result.trim() || undefined,
      }),
    onSuccess: () => {
      setSummary('')
      setChallenge('')
      setResult('')
      invalidate()
    },
    onError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteWorkLog(taskId, id),
    onSuccess: invalidate,
    onError,
  })

  const total = logs.reduce((sum, w) => sum + w.durationMinutes, 0)
  const canSubmit = summary.trim() && Number(minutes) > 0

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        工作记录
        <span className="text-xs font-normal text-gray-500">
          实际投入 {fmtMinutes(total)}（仅统计工作记录，不含已排日程）
        </span>
      </h3>
      <ul className="flex flex-col gap-2">
        {logs.map((log) => (
          <li key={log.id} className="rounded-md bg-gray-50 p-2 text-xs text-gray-700">
            <div className="flex items-center gap-2">
              <span className="font-medium">{log.workedAt}</span>
              <span>{fmtMinutes(log.durationMinutes)}</span>
              <button
                onClick={() => remove.mutate(log.id)}
                className="ml-auto text-red-500 hover:underline"
              >
                删除
              </button>
            </div>
            <p className="mt-1">{log.summary}</p>
            {log.challenge && <p className="mt-0.5 text-gray-500">困难：{log.challenge}</p>}
            {log.result && <p className="mt-0.5 text-gray-500">结果：{log.result}</p>}
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSubmit) create.mutate()
        }}
      >
        <div className="flex gap-2">
          <input
            type="date"
            value={workedAt}
            onChange={(e) => setWorkedAt(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          />
          <input
            type="number"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm"
            placeholder="分钟"
          />
          <span className="self-center text-xs text-gray-400">分钟</span>
        </div>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="做了什么（必填）"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        <input
          value={challenge}
          onChange={(e) => setChallenge(e.target.value)}
          placeholder="遇到的困难（可选）"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        <input
          value={result}
          onChange={(e) => setResult(e.target.value)}
          placeholder="结果（可选）"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={!canSubmit || create.isPending}
          className="self-start rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          记录投入
        </button>
      </form>
    </section>
  )
}
