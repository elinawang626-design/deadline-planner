import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { generatePlanPrompt, importPlan, validatePlanOutput } from '../api/aiimport'
import { MODE_LABELS } from '../api/aiPlan'
import { useUI } from '../store/ui'
import type { ChangeKind, PlanChange, PlanMode, PlanPreview } from '../types'

const textareaCls =
  'h-40 w-full rounded-md border border-gray-300 p-2 font-mono text-xs focus:border-blue-500 focus:outline-none'
const btnCls = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50'
const primaryBtnCls =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50'
const sectionCls = 'rounded-lg border border-gray-200 bg-white p-4'

const MODE_HINTS: Record<PlanMode, string> = {
  ai_plan: 'AI 综合全部任务直接生成时间块；未来未锁定的机器安排会被替换',
  ai_optimize: '保留人工/锁定/已完成/本地安排，只重新规划未来的 AI 时间块',
  tasks_only: 'AI 只整理任务属性，由本地确定性算法排程',
}

const KIND_LABELS: Record<ChangeKind, string> = {
  task_add: '新增任务',
  task_update: '更新任务',
  task_delete: '删除任务',
  event_add: '新增事件',
  event_update: '更新事件',
  event_delete: '删除事件',
  availability_add: '新增可用时间',
  availability_update: '更新可用时间',
  availability_delete: '删除可用时间',
  block_add: '新增时间块',
  block_move: '移动时间块',
  block_remove: '移除时间块',
}

const KIND_COLORS: Record<string, string> = {
  add: 'bg-green-100 text-green-700',
  update: 'bg-blue-100 text-blue-700',
  move: 'bg-amber-100 text-amber-700',
  delete: 'bg-red-100 text-red-700',
  remove: 'bg-red-100 text-red-700',
}

const KEPT_REASON_LABELS: Record<string, string> = {
  manual: '手动',
  locked: '锁定',
  done: '已完成',
  past: '已过去',
  not_replaced: '保留',
}

function kindBadge(kind: ChangeKind) {
  const suffix = kind.split('_').pop() ?? ''
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${KIND_COLORS[suffix] ?? 'bg-gray-100 text-gray-700'}`}
    >
      {KIND_LABELS[kind]}
    </span>
  )
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return format(new Date(value), 'MM-dd HH:mm')
  }
  return String(value)
}

interface ChangeRowProps {
  change: PlanChange
  checked: boolean
  blockedByDependency: boolean
  onToggle: (changeId: string) => void
}

function ChangeRow({ change, checked, blockedByDependency, onToggle }: ChangeRowProps) {
  return (
    <li
      className={`rounded-md border p-2 ${checked ? 'border-gray-200' : 'border-gray-100 bg-gray-50 opacity-70'}`}
    >
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          disabled={blockedByDependency}
          onChange={() => onToggle(change.changeId)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {kindBadge(change.kind)}
            <span>{change.summary}</span>
          </div>
          {change.fields.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-gray-500">
              {change.fields.map((f) => (
                <li key={f.field}>
                  {f.field}：
                  {f.old !== undefined && f.old !== null && (
                    <>
                      <span className="line-through">{formatValue(f.old)}</span>
                      {' → '}
                    </>
                  )}
                  <span className="text-gray-700">{formatValue(f.new)}</span>
                </li>
              ))}
            </ul>
          )}
          {blockedByDependency && (
            <p className="mt-1 text-xs text-amber-600">依赖的变更已被取消，此项一并跳过</p>
          )}
        </div>
      </label>
    </li>
  )
}

export default function AIImportPage() {
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const setLastSummary = useUI((s) => s.setLastSummary)

  const [mode, setMode] = useState<PlanMode>('ai_plan')
  const [requirements, setRequirements] = useState('')
  const [prompt, setPrompt] = useState('')
  const [output, setOutput] = useState('')
  const [preview, setPreview] = useState<PlanPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const clearPreview = () => {
    setPreview(null)
    setSelected(new Set())
  }

  const onGenerate = async () => {
    setBusy(true)
    try {
      setPrompt(await generatePlanPrompt(mode, requirements))
    } catch (error: unknown) {
      pushToast('error', error instanceof Error ? error.message : '生成提示词失败')
    } finally {
      setBusy(false)
    }
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      pushToast('success', '提示词已复制到剪贴板')
    } catch {
      pushToast('error', '复制失败，请手动选择文本复制')
    }
  }

  const onValidate = async (text = output) => {
    setBusy(true)
    try {
      const result = await validatePlanOutput(text, mode)
      setPreview(result)
      setSelected(new Set(result.changes.map((c) => c.changeId)))
      if (result.ok) pushToast('success', `解析成功：${result.changes.length} 项变更`)
    } finally {
      setBusy(false)
    }
  }

  const toggleChange = (changeId: string) => {
    if (!preview) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(changeId)) {
        next.delete(changeId)
        // transitively drop changes whose dependencies were just rejected
        let changed = true
        while (changed) {
          changed = false
          for (const change of preview.changes) {
            if (next.has(change.changeId) && change.dependsOn.some((dep) => !next.has(dep))) {
              next.delete(change.changeId)
              changed = true
            }
          }
        }
      } else {
        next.add(changeId)
        for (const dep of preview.changes.find((c) => c.changeId === changeId)?.dependsOn ?? []) {
          next.add(dep)
        }
      }
      return next
    })
  }

  const onImport = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const acceptedAll = selected.size === preview.changes.length
      const result = await importPlan(
        output,
        mode,
        preview.previewVersion,
        acceptedAll ? undefined : [...selected],
      )
      if (result.scheduleSummary) setLastSummary(result.scheduleSummary)
      for (const key of ['tasks', 'blocks', 'availability', 'fixed-events']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      pushToast(
        'success',
        `已应用 ${result.applied} 项变更` +
          (result.rejected ? `，跳过 ${result.rejected} 项` : '') +
          (result.scheduleSummary ? '，并已本地重排日程' : ''),
      )
      setOutput('')
      clearPreview()
    } catch (error: unknown) {
      pushToast('error', error instanceof Error ? error.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="mb-1 text-lg font-semibold">AI 规划（手工 LLM 流程）</h2>
      <p className="mb-4 text-sm text-gray-500">
        本应用不调用任何 LLM API。流程：① 选模式、写要求 → ② 生成并复制提示词 → ③ 粘贴外部 AI
        的完整回复 → ④ 逐条确认变更后写入。
      </p>
      <div className="flex flex-col gap-4">
        <section className={sectionCls}>
          <h3 className="mb-2 text-sm font-semibold">① 规划模式与本次要求</h3>
          <div className="mb-3 flex flex-col gap-2">
            {(Object.keys(MODE_LABELS) as PlanMode[]).map((m) => (
              <label key={m} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="plan-mode"
                  className="mt-0.5"
                  checked={mode === m}
                  onChange={() => {
                    setMode(m)
                    clearPreview()
                  }}
                />
                <span>
                  <span className="font-medium">{MODE_LABELS[m]}</span>
                  <span className="ml-2 text-xs text-gray-500">{MODE_HINTS[m]}</span>
                </span>
              </label>
            ))}
          </div>
          <textarea
            className={`${textareaCls} h-20`}
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder="本次要求（可选）：例如考试周以复习为主、每天 19 点后不安排、周三留空……"
          />
        </section>

        <section className={sectionCls}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">② 生成的提示词（复制给任意外部 AI）</h3>
            <div className="flex gap-2">
              <button
                onClick={() => void onGenerate()}
                disabled={busy}
                className={`${btnCls} disabled:opacity-50`}
              >
                生成提示词
              </button>
              <button
                onClick={() => void onCopy()}
                disabled={!prompt}
                className={`${btnCls} disabled:opacity-50`}
              >
                复制提示词
              </button>
            </div>
          </div>
          <textarea className={textareaCls} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </section>

        <section className={sectionCls}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">③ 粘贴外部 AI 的完整回复</h3>
            <button
              onClick={() => void onValidate()}
              disabled={busy || !output}
              className={`${btnCls} disabled:opacity-50`}
            >
              解析并预览
            </button>
          </div>
          <textarea
            className={textareaCls}
            value={output}
            onChange={(e) => {
              setOutput(e.target.value)
              clearPreview()
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text')
              if (text.trim()) void onValidate(text)
            }}
            placeholder="支持纯 JSON、```json 代码块或附带说明文字的回复，粘贴后自动解析"
          />
        </section>

        {preview && (
          <section className={sectionCls}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">④ 变更预览（{preview.changes.length} 项）</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => setSelected(new Set(preview.changes.map((c) => c.changeId)))}
                  className={btnCls}
                >
                  全选
                </button>
                <button
                  onClick={() => void onImport()}
                  disabled={busy || !preview.ok || selected.size === 0}
                  className={primaryBtnCls}
                >
                  应用所选（{selected.size}）
                </button>
              </div>
            </div>
            {preview.errors.length > 0 && (
              <ul className="mb-2 list-inside list-disc rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                {preview.errors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            )}
            {preview.warnings.length > 0 && (
              <ul className="mb-2 list-inside list-disc rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                {preview.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            )}
            {preview.useLocalScheduler && (
              <p className="mb-2 text-xs text-gray-500">
                本次只导入任务相关修改，确认后由本地算法自动重排全部 active 任务。
              </p>
            )}
            {preview.changes.length === 0 ? (
              <p className="text-sm text-gray-500">没有需要应用的变更（所有记录与现状一致）。</p>
            ) : (
              <ul className="space-y-2">
                {preview.changes.map((change) => (
                  <ChangeRow
                    key={change.changeId}
                    change={change}
                    checked={selected.has(change.changeId)}
                    blockedByDependency={change.dependsOn.some((dep) => !selected.has(dep))}
                    onToggle={toggleChange}
                  />
                ))}
              </ul>
            )}
            {preview.keptBlocks.length > 0 && (
              <details className="mt-3 text-xs text-gray-500">
                <summary className="cursor-pointer">
                  保留不动的未来时间块（{preview.keptBlocks.length} 个）
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {preview.keptBlocks.map((b) => (
                    <li key={b.id}>
                      {format(new Date(b.startAt), 'MM-dd HH:mm')}–
                      {format(new Date(b.endAt), 'HH:mm')}（
                      {KEPT_REASON_LABELS[b.reason] ?? b.reason}）
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
