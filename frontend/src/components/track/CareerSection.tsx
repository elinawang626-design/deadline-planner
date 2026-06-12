import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  careerPrompt,
  exportCareerCardMarkdown,
  getCareerCard,
  importCareerCard,
  patchCareerCard,
} from '../../api/track'
import { useUI } from '../../store/ui'
import type { CareerCard, Task } from '../../types'

const LIST_FIELDS = [
  ['actions', '关键行动'],
  ['challenges', '难点'],
  ['outcomes', '解决方法与结果'],
  ['metrics', '可量化指标'],
  ['skills', '使用技能'],
] as const

type ListField = (typeof LIST_FIELDS)[number][0]

function CardEditor({
  taskId,
  card,
}: {
  taskId: string
  card: CareerCard
}) {
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const [editing, setEditing] = useState(false)
  const [context, setContext] = useState(card.context)
  const [role, setRole] = useState(card.role)
  const [lists, setLists] = useState<Record<ListField, string>>({
    actions: card.actions.join('\n'),
    challenges: card.challenges.join('\n'),
    outcomes: card.outcomes.join('\n'),
    metrics: card.metrics.join('\n'),
    skills: card.skills.join('\n'),
  })

  const save = useMutation({
    mutationFn: () => {
      const toList = (value: string) =>
        value.split('\n').map((line) => line.trim()).filter(Boolean)
      return patchCareerCard(taskId, {
        context: context.trim(),
        role: role.trim(),
        actions: toList(lists.actions),
        challenges: toList(lists.challenges),
        outcomes: toList(lists.outcomes),
        metrics: toList(lists.metrics),
        skills: toList(lists.skills),
      })
    },
    onSuccess: () => {
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: ['career-card', taskId] })
      pushToast('success', '素材卡已更新')
    },
    onError: (error: unknown) =>
      pushToast('error', error instanceof Error ? error.message : '保存失败'),
  })

  if (!editing) {
    return (
      <div className="flex flex-col gap-2 text-xs text-gray-700">
        <p>
          <span className="font-semibold">背景：</span>
          {card.context}
        </p>
        <p>
          <span className="font-semibold">个人角色：</span>
          {card.role}
        </p>
        {LIST_FIELDS.map(([field, label]) => (
          <div key={field}>
            <span className="font-semibold">{label}：</span>
            {card[field].length ? (
              <ul className="ml-4 list-disc">
                {card[field].map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : (
              <span className="text-gray-400">（无）</span>
            )}
          </div>
        ))}
        <button
          onClick={() => setEditing(true)}
          className="self-start text-blue-600 hover:underline"
        >
          编辑
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 text-xs">
      <label className="font-semibold">背景</label>
      <textarea
        value={context}
        onChange={(e) => setContext(e.target.value)}
        className="rounded-md border border-gray-300 p-2"
      />
      <label className="font-semibold">个人角色</label>
      <textarea
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="rounded-md border border-gray-300 p-2"
      />
      {LIST_FIELDS.map(([field, label]) => (
        <div key={field} className="flex flex-col gap-1">
          <label className="font-semibold">{label}（每行一条）</label>
          <textarea
            value={lists[field]}
            onChange={(e) => setLists({ ...lists, [field]: e.target.value })}
            className="rounded-md border border-gray-300 p-2"
          />
        </div>
      ))}
      <div className="flex gap-2">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !context.trim() || !role.trim()}
          className="rounded-md bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          保存
        </button>
        <button onClick={() => setEditing(false)} className="text-gray-500 hover:underline">
          取消
        </button>
      </div>
    </div>
  )
}

export function CareerSection({ task }: { task: Task }) {
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const [confirmedMetrics, setConfirmedMetrics] = useState('')
  const [prompt, setPrompt] = useState('')
  const [reply, setReply] = useState('')

  const { data: card } = useQuery({
    queryKey: ['career-card', task.id],
    queryFn: () => getCareerCard(task.id),
  })

  const onError = (error: unknown) =>
    pushToast('error', error instanceof Error ? error.message : '操作失败')

  const generate = useMutation({
    mutationFn: () => careerPrompt(task.id, confirmedMetrics),
    onSuccess: setPrompt,
    onError,
  })
  const doImport = useMutation({
    mutationFn: () => importCareerCard(task.id, reply),
    onSuccess: () => {
      setReply('')
      queryClient.invalidateQueries({ queryKey: ['career-card', task.id] })
      pushToast('success', '职业素材卡已保存')
    },
    onError,
  })
  const exportMd = useMutation({
    mutationFn: () => exportCareerCardMarkdown(task.id),
    onSuccess: (markdown) => {
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${task.title}-职业素材卡.md`
      anchor.click()
      URL.revokeObjectURL(url)
    },
    onError,
  })

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold">职业素材卡</h3>
      {task.status !== 'completed' && (
        <p className="mb-2 text-xs text-gray-400">任务完成后生成效果最佳，也可以随时生成。</p>
      )}
      <div className="flex flex-col gap-2">
        <input
          value={confirmedMetrics}
          onChange={(e) => setConfirmedMetrics(e.target.value)}
          placeholder="你确认的可量化指标（可选，如：测试覆盖率 85%）…"
          className="rounded-md border border-gray-300 px-2 py-1 text-xs"
        />
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="self-start rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {generate.isPending ? '生成中…' : '生成素材卡提示词'}
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
          placeholder="把外部 AI 返回的素材卡 JSON 粘贴到这里…"
          className="h-24 w-full rounded-md border border-gray-300 p-2 font-mono text-xs"
        />
        <button
          onClick={() => doImport.mutate()}
          disabled={!reply.trim() || doImport.isPending}
          className="self-start rounded-md bg-gray-700 px-3 py-1 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
        >
          校验并保存素材卡
        </button>
      </div>

      {card && (
        <div className="mt-4 rounded-md bg-gray-50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <h4 className="text-xs font-semibold text-gray-600">当前素材卡</h4>
            <button
              onClick={() => exportMd.mutate()}
              className="ml-auto text-xs text-blue-600 hover:underline"
            >
              导出 Markdown
            </button>
          </div>
          <CardEditor key={card.updatedAt} taskId={task.id} card={card} />
        </div>
      )}
    </section>
  )
}
