import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { generatePrompt, importOutput, validateOutput } from '../api/aiimport'
import { regenerateSchedule } from '../api/schedule'
import { useUI } from '../store/ui'

const textareaCls =
  'h-40 w-full rounded-md border border-gray-300 p-2 font-mono text-xs focus:border-blue-500 focus:outline-none'
const btnCls = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50'

export default function AIImportPage() {
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const setLastSummary = useUI((s) => s.setLastSummary)
  const [raw, setRaw] = useState('')
  const [prompt, setPrompt] = useState('')
  const [output, setOutput] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const onGenerate = async () => {
    setBusy(true)
    try {
      setPrompt(await generatePrompt(raw))
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

  const onValidate = async () => {
    setBusy(true)
    try {
      const result = await validateOutput(output)
      setErrors(result.errors)
      if (result.ok) pushToast('success', `校验通过：${result.count} 个任务`)
    } finally {
      setBusy(false)
    }
  }

  const onImport = async () => {
    setBusy(true)
    try {
      const result = await validateOutput(output)
      setErrors(result.errors)
      if (!result.ok) return
      const imported = await importOutput(output)
      setLastSummary(await regenerateSchedule())
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['blocks'] })
      pushToast('success', `已导入 ${imported} 个任务并重排日程`)
    } catch (error: unknown) {
      pushToast('error', error instanceof Error ? error.message : '导入失败')
    } finally {
      setBusy(false)
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
          <label className="mb-1 block text-sm font-medium">① 原始需求（自然语言，随便写）</label>
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
              <button onClick={() => void onGenerate()} disabled={busy || !raw} className={`${btnCls} disabled:opacity-50`}>
                生成提示词
              </button>
              <button onClick={() => void onCopy()} disabled={!prompt} className={`${btnCls} disabled:opacity-50`}>
                复制提示词
              </button>
            </div>
          </div>
          <textarea className={textareaCls} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium">③ LLM 返回的 JSON</label>
            <div className="flex gap-2">
              <button onClick={() => void onValidate()} disabled={busy || !output} className={`${btnCls} disabled:opacity-50`}>
                校验 JSON
              </button>
              <button
                onClick={() => void onImport()}
                disabled={busy || !output}
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
