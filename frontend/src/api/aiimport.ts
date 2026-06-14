import { USE_MOCK, apiFetch } from './client'
import {
  deleteProviderKey as deleteProviderKeyMock,
  generatePlanPromptMock,
  importPlanMock,
  runPlan as runPlanMock,
  saveProviderKey as saveProviderKeyMock,
  testProviderKey as testProviderKeyMock,
  validatePlanOutputMock,
} from './mock'
import type {
  PlanImportResult,
  PlanMode,
  PlanPreview,
  ProviderName,
  RunResult,
} from '../types'

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

export async function runPlan(mode: PlanMode, requirements: string): Promise<RunResult> {
  if (USE_MOCK) return runPlanMock()
  try {
    return await apiFetch<RunResult>('/ai-import/run', {
      method: 'POST',
      body: JSON.stringify({ mode, requirements }),
    })
  } catch (error: unknown) {
    throw new Error(backendErrors(error).join('；'), { cause: error })
  }
}

export function saveProviderKey(
  provider: ProviderName,
  key: string,
): Promise<{ configured: Record<ProviderName, boolean> }> {
  if (USE_MOCK) return saveProviderKeyMock(provider).then((configured) => ({ configured }))
  return apiFetch(`/ai-import/keys/${provider}`, {
    method: 'PUT',
    body: JSON.stringify({ key }),
  })
}

export function deleteProviderKey(
  provider: ProviderName,
): Promise<{ configured: Record<ProviderName, boolean> }> {
  if (USE_MOCK) return deleteProviderKeyMock(provider).then((configured) => ({ configured }))
  return apiFetch(`/ai-import/keys/${provider}`, { method: 'DELETE' })
}

export async function testProviderKey(provider: ProviderName): Promise<void> {
  if (USE_MOCK) {
    await testProviderKeyMock()
    return
  }
  try {
    await apiFetch(`/ai-import/keys/${provider}/test`, { method: 'POST' })
  } catch (error: unknown) {
    throw new Error(backendErrors(error).join('；'), { cause: error })
  }
}
