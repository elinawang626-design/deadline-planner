import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { USE_MOCK } from '../api/client'
import { importParsedTasks, type ParsedLlmTask } from '../api/mock'
import { regenerateSchedule } from '../api/schedule'
import { useUI } from '../store/ui'

const textareaCls =
  'h-40 w-full rounded-md border border-gray-300 p-2 font-mono text-xs focus:border-blue-500 focus:outline-none'
const btnCls = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50'
const labelCls = 'mb-1 block text-sm font-medium'

function buildLocalPrompt(raw: string): string {
  // TODO(backend): replace with POST /api/ai-import/generate-prompt so the
  // prompt template and JSON Schema stay identical to the CLI's
  // `planner generate-prompt`.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return [
    'You are a task-parsing assistant for a local scheduling tool.',
    '',
    `Current time: ${new Date().toISOString()}`,
    `Timezone: ${tz}`,
    '',
    "## User's raw input",
    raw,
    '',
    '## Your job',
    'Convert the raw input into ONE JSON object, no prose, no code fences needed:',
    '{',
    '  "tasks": [{',
    '    "id": "stable-id",',
    '    "title": "...",',
    '    "deadline": "ISO 8601 with UTC offset",',
    '    "estimated_hours": <positive integer>,',
    '    "priority": "high" | "medium" | "low",',
    '    "earliest_start_at": "optional ISO 8601"',
    '  }]',
    '}',
    'Do NOT produce any calendar blocks; the local tool schedules deterministically.',
  ].join('\n')
}

function stripFences(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/)
  return (match ? match[1] : text).trim()
}

export default function AIImportPage() {
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const setLastSummary = useUI((s) => s.setLastSummary)
  const [raw, setRaw] = useState('')
  const [prompt, setPrompt] = useState('')
  const [output, setOutput] = useState('')
  const [errors, setErrors] = useState<string[]>([])

  const validate = (): ParsedLlmTask[] | null => {
    // TODO(backend): replace with POST /api/ai-import/validate-output, which
    // runs the backend's strict Pydantic validation (extra fields rejected).
    const problems: string[] = []
    let data: unknown
    try {
      data = JSON.parse(stripFences(output))
    } catch {
      setErrors(['不是合法 JSON（允许纯 JSON 或单个 ```json 围栏块）'])
      return null
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      problems.push('顶层必须是 JSON 对象')
    }
    const tasks = (data as { tasks?: unknown }).tasks
    if (!Array.isArray(tasks) || tasks.length === 0) {
      problems.push('缺少非空 tasks 数组')
    }
    const parsed: ParsedLlmTask[] = []
    if (Array.isArray(tasks)) {
      tasks.forEach((entry, i) => {
        const item = entry as Record<string, unknown>
        if (typeof item.title !== 'string' || !item.title) {
          problems.push(`tasks[${i}].title 缺失`)
        }
        if (typeof item.deadline !== 'string' || !/([+-]\d{2}:?\d{2}|Z)$/.test(item.deadline)) {
          problems.push(`tasks[${i}].deadline 必须是带时区偏移的 ISO 8601`)
        }
        if (
          typeof item.estimated_hours !== 'number' ||
          item.estimated_hours <= 0 ||
          !Number.isInteger(item.estimated_hours)
        ) {
          problems.push(`tasks[${i}].estimated_hours 必须是正整数`)
        }
        if (item.priority !== 'high' && item.priority !== 'medium' && item.priority !== 'low') {
          problems.push(`tasks[${i}].priority 必须是 high/medium/low`)
        }
        if (problems.length === 0) parsed.push(item as unknown as ParsedLlmTask)
      })
    }
    setErrors(problems)
    if (problems.length) return null
    pushToast('success', `校验通过：${parsed.length} 个任务`)
    return parsed
  }

  const importTasks = async () => {
    const parsed = validate()
    if (!parsed) return
    if (!USE_MOCK) {
      // TODO(backend): POST /api/ai-import/import
      pushToast('error', '后端 /api/ai-import/import 尚未就绪')
      return
    }
    await importParsedTasks(parsed)
    setLastSummary(await regenerateSchedule())
    queryClient.invalidateQueries({ queryKey: ['tasks'] })
    queryClient.invalidateQueries({ queryKey: ['blocks'] })
    pushToast('success', `已导入 ${parsed.length} 个任务并重排日程`)
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      pushToast('success', '提示词已复制到剪贴板')
    } catch {
      pushToast('error', '复制失败，请手动选择文本复制')
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="mb-1 text-lg font-semibold">AI 导入（手工 LLM 流程）</h2>
      <p className="mb-4 text-sm text-gray-500">
        本应用不调用任何 LLM API、不需要 API key。流程：① 粘贴原始需求 → ② 生成提示词 → ③
        复制到 ChatGPT/Claude 等任意 LLM → ④ 把模型返回的 JSON 粘回 → ⑤ 校验 → ⑥ 导入并重排日程。
      </p>
      <div className="flex flex-col gap-4">
        <div>
          <label className={labelCls}>① 原始需求（自然语言，随便写）</label>
          <textarea
            className={textareaCls}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="例：下周一 18 点前交季度报告，大概 3 小时，优先级高；周四上午有牙医……"
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium">② 生成的提示词</label>
            <div className="flex gap-2">
              <button onClick={() => setPrompt(buildLocalPrompt(raw))} className={btnCls}>
                生成提示词
              </button>
              <button onClick={copyPrompt} disabled={!prompt} className={`${btnCls} disabled:opacity-50`}>
                复制提示词
              </button>
            </div>
          </div>
          <textarea className={textareaCls} value={prompt} onChange={(e) => setPrompt(e.target.value)} readOnly={false} />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium">③ LLM 返回的 JSON</label>
            <div className="flex gap-2">
              <button onClick={() => validate()} disabled={!output} className={`${btnCls} disabled:opacity-50`}>
                校验 JSON
              </button>
              <button
                onClick={() => void importTasks()}
                disabled={!output}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                导入任务
              </button>
            </div>
          </div>
          <textarea
            className={textareaCls}
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            placeholder='{"tasks": [...]}'
          />
          {errors.length > 0 && (
            <ul className="mt-2 list-inside list-disc rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {errors.map((error, i) => (
                <li key={i}>{error}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
