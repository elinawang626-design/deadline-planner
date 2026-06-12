import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import {
  applyEstimate,
  estimatePrompt,
  importEstimate,
  listAttachments,
  listEstimates,
} from '../../api/track'
import { useUI } from '../../store/ui'
import { fmtMinutes } from '../../lib/labels'
import type { Confidence } from '../../types'

const CONFIDENCE_LABELS: Record<Confidence, string> = {
  low: '信心低',
  medium: '信心中',
  high: '信心高',
}

export function EstimateSection({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [reply, setReply] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data: attachments = [] } = useQuery({
    queryKey: ['attachments', taskId],
    queryFn: () => listAttachments(taskId),
  })
  const { data: estimates = [] } = useQuery({
    queryKey: ['estimates', taskId],
    queryFn: () => listEstimates(taskId),
  })

  const onError = (error: unknown) =>
    pushToast('error', error instanceof Error ? error.message : '操作失败')

  const generate = useMutation({
    mutationFn: () => estimatePrompt(taskId, selectedIds),
    onSuccess: (result) => setPrompt(result.prompt),
    onError,
  })
  const doImport = useMutation({
    mutationFn: () => importEstimate(taskId, reply),
    onSuccess: () => {
      setReply('')
      queryClient.invalidateQueries({ queryKey: ['estimates', taskId] })
      pushToast('success', '估时已保存为历史记录；点击「采用」才会更新排期')
    },
    onError,
  })
  const apply = useMutation({
    mutationFn: (estimateId: string) => applyEstimate(taskId, estimateId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['estimates', taskId] })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['blocks'] })
      pushToast(
        'success',
        `已采用估时 ${fmtMinutes(result.estimate.likelyMinutes)} 并重新排期（新增 ${result.summary.createdBlocks} 块）`,
      )
    },
    onError,
  })

  const parsable = attachments.filter((a) => a.extractionStatus === 'ok')

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold">AI 估时</h3>
      <div className="flex flex-col gap-2">
        {parsable.length > 0 && (
          <div className="text-xs">
            <p className="mb-1 text-gray-500">选择要加入提示词的附件（仅已解析的可选）：</p>
            {parsable.map((att) => (
              <label key={att.id} className="mr-3 inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(att.id)}
                  onChange={(e) =>
                    setSelectedIds(
                      e.target.checked
                        ? [...selectedIds, att.id]
                        : selectedIds.filter((id) => id !== att.id),
                    )
                  }
                />
                {att.displayName}
              </label>
            ))}
          </div>
        )}
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="self-start rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {generate.isPending ? '生成中…' : '生成估时提示词'}
        </button>
        {prompt && (
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs text-gray-500">复制给任意外部 AI：</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(prompt)
                  pushToast('success', '提示词已复制')
                }}
                className="text-xs text-blue-600 hover:underline"
              >
                复制
              </button>
            </div>
            <textarea
              readOnly
              value={prompt}
              className="h-32 w-full rounded-md border border-gray-200 bg-gray-50 p-2 font-mono text-xs"
            />
          </div>
        )}
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="把外部 AI 返回的估时 JSON 粘贴到这里…"
          className="h-24 w-full rounded-md border border-gray-300 p-2 font-mono text-xs"
        />
        <button
          onClick={() => doImport.mutate()}
          disabled={!reply.trim() || doImport.isPending}
          className="self-start rounded-md bg-gray-700 px-3 py-1 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
        >
          校验并保存估时
        </button>
      </div>

      <h4 className="mt-4 mb-2 text-xs font-semibold text-gray-600">估时历史</h4>
      <ul className="flex flex-col gap-2">
        {estimates.map((est) => (
          <li key={est.id} className="rounded-md bg-gray-50 p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {fmtMinutes(est.optimisticMinutes)} / {fmtMinutes(est.likelyMinutes)} /{' '}
                {fmtMinutes(est.pessimisticMinutes)}
              </span>
              <span className="text-gray-500">{CONFIDENCE_LABELS[est.confidence]}</span>
              <span className="text-gray-400">
                {format(parseISO(est.createdAt), 'M/d HH:mm')}
              </span>
              {est.appliedAt ? (
                <span className="rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700">
                  已采用
                </span>
              ) : (
                <button
                  onClick={() => apply.mutate(est.id)}
                  disabled={apply.isPending}
                  className="rounded bg-blue-600 px-2 py-0.5 text-[10px] text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  采用并重排
                </button>
              )}
              <button
                onClick={() => setExpandedId(expandedId === est.id ? null : est.id)}
                className="ml-auto text-gray-500 hover:underline"
              >
                {expandedId === est.id ? '收起' : '详情'}
              </button>
            </div>
            {expandedId === est.id && (
              <div className="mt-2 flex flex-col gap-1 text-gray-600">
                {est.breakdown.length > 0 && (
                  <p>步骤：{est.breakdown.map((b) => `${b.step} ${fmtMinutes(b.minutes)}`).join('；')}</p>
                )}
                {est.assumptions.length > 0 && <p>假设：{est.assumptions.join('；')}</p>}
                {est.risks.length > 0 && <p>风险：{est.risks.join('；')}</p>}
                {est.sourceAttachmentIds.length > 0 && (
                  <p>依据附件：{est.sourceAttachmentIds.join(', ')}</p>
                )}
              </div>
            )}
          </li>
        ))}
        {estimates.length === 0 && (
          <p className="text-xs text-gray-400">还没有估时记录。乐观 / 最可能 / 悲观三个值中，只有「最可能」会在采用后用于排期。</p>
        )}
      </ul>
    </section>
  )
}
