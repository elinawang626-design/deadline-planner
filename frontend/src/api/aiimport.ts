import { USE_MOCK, apiFetch } from './client'
import { importParsedTasks, type ParsedLlmTask } from './mock'

export interface ValidateResult {
  ok: boolean
  errors: string[]
  count: number
}

function buildLocalPrompt(rawInput: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return [
    'You are a task-parsing assistant for a local scheduling tool.',
    '',
    `Current time: ${new Date().toISOString()}`,
    `Timezone: ${tz}`,
    '',
    "## User's raw input",
    rawInput,
    '',
    '## Your job',
    'Convert the raw input into ONE JSON object, no prose:',
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

function validateLocally(text: string): { result: ValidateResult; tasks: ParsedLlmTask[] } {
  const problems: string[] = []
  const tasks: ParsedLlmTask[] = []
  let data: unknown
  try {
    data = JSON.parse(stripFences(text))
  } catch {
    return {
      result: { ok: false, errors: ['不是合法 JSON（允许纯 JSON 或单个 ```json 围栏块）'], count: 0 },
      tasks,
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    problems.push('顶层必须是 JSON 对象')
  }
  const rawTasks = (data as { tasks?: unknown }).tasks
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    problems.push('缺少非空 tasks 数组')
  } else {
    rawTasks.forEach((entry, i) => {
      const item = entry as Record<string, unknown>
      if (typeof item.title !== 'string' || !item.title) problems.push(`tasks[${i}].title 缺失`)
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
      if (problems.length === 0) tasks.push(item as unknown as ParsedLlmTask)
    })
  }
  return { result: { ok: problems.length === 0, errors: problems, count: tasks.length }, tasks }
}

function backendErrors(error: unknown): string[] {
  // backend returns 422 with {"detail": {"errors": [...]}}
  if (error instanceof Error) {
    const match = error.message.match(/\{.*\}$/s)
    if (match) {
      try {
        const body = JSON.parse(match[0]) as { detail?: { errors?: string[] } }
        if (body.detail?.errors) return body.detail.errors
      } catch {
        // fall through to the generic message
      }
    }
    return [error.message]
  }
  return ['校验失败']
}

export async function generatePrompt(rawInput: string): Promise<string> {
  if (USE_MOCK) return buildLocalPrompt(rawInput)
  const res = await apiFetch<{ prompt: string }>('/ai-import/generate-prompt', {
    method: 'POST',
    body: JSON.stringify({ rawInput }),
  })
  return res.prompt
}

export async function validateOutput(text: string): Promise<ValidateResult> {
  if (USE_MOCK) return validateLocally(text).result
  try {
    return await apiFetch<ValidateResult>('/ai-import/validate-output', {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  } catch (error: unknown) {
    return { ok: false, errors: backendErrors(error), count: 0 }
  }
}

export async function importOutput(text: string): Promise<number> {
  if (USE_MOCK) {
    const { result, tasks } = validateLocally(text)
    if (!result.ok) throw new Error(result.errors.join('；'))
    return importParsedTasks(tasks)
  }
  const res = await apiFetch<{ imported: number }>('/ai-import/import', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  return res.imported
}
