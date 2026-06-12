import { USE_MOCK, apiFetch } from './client'
import { generatePlanPromptMock, importPlanMock, validatePlanOutputMock } from './mock'
import type { PlanImportResult, PlanMode, PlanPreview } from '../types'

function backendErrors(error: unknown): string[] {
  // backend returns 409/422 with {"detail": {"errors": [...]}}
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
  return ['请求失败']
}

const EMPTY_PREVIEW: Omit<PlanPreview, 'ok' | 'errors'> = {
  warnings: [],
  previewVersion: '',
  summary: {},
  changes: [],
  keptBlocks: [],
  useLocalScheduler: false,
}

export async function generatePlanPrompt(
  mode: PlanMode,
  requirements: string,
): Promise<string> {
  if (USE_MOCK) return generatePlanPromptMock(mode, requirements)
  const res = await apiFetch<{ prompt: string }>('/ai-import/generate-prompt', {
    method: 'POST',
    body: JSON.stringify({ mode, requirements }),
  })
  return res.prompt
}

export async function validatePlanOutput(
  text: string,
  mode: PlanMode,
): Promise<PlanPreview> {
  if (USE_MOCK) return validatePlanOutputMock(text, mode)
  try {
    return await apiFetch<PlanPreview>('/ai-import/validate-output', {
      method: 'POST',
      body: JSON.stringify({ text, mode }),
    })
  } catch (error: unknown) {
    return { ok: false, errors: backendErrors(error), ...EMPTY_PREVIEW }
  }
}

export async function importPlan(
  text: string,
  mode: PlanMode,
  previewVersion: string,
  acceptedChangeIds?: string[],
): Promise<PlanImportResult> {
  if (USE_MOCK) return importPlanMock(text, mode, previewVersion, acceptedChangeIds)
  try {
    return await apiFetch<PlanImportResult>('/ai-import/import', {
      method: 'POST',
      body: JSON.stringify({ text, mode, previewVersion, acceptedChangeIds }),
    })
  } catch (error: unknown) {
    throw new Error(backendErrors(error).join('；'), { cause: error })
  }
}
