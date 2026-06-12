/** Task tracking API: checklist, work logs, attachments, estimates, career cards. */
import { API_BASE, USE_MOCK, apiFetch } from './client'
import * as mock from './mockTrack'
import type {
  ApplyEstimateResult,
  Attachment,
  CareerCard,
  ChecklistItem,
  Estimate,
  EstimatePromptResult,
  TrackingSummary,
  WorkLog,
} from '../types'

// ---- checklist ----

export function listChecklist(taskId: string): Promise<ChecklistItem[]> {
  if (USE_MOCK) return mock.listChecklist(taskId)
  return apiFetch(`/tasks/${taskId}/checklist`)
}

export function createChecklistItem(taskId: string, title: string): Promise<ChecklistItem> {
  if (USE_MOCK) return mock.createChecklistItem(taskId, title)
  return apiFetch(`/tasks/${taskId}/checklist`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export function updateChecklistItem(
  taskId: string,
  itemId: string,
  patch: Partial<Pick<ChecklistItem, 'title' | 'completed' | 'position'>>,
): Promise<ChecklistItem> {
  if (USE_MOCK) return mock.updateChecklistItem(taskId, itemId, patch)
  return apiFetch(`/tasks/${taskId}/checklist/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteChecklistItem(taskId: string, itemId: string): Promise<void> {
  if (USE_MOCK) return mock.deleteChecklistItem(taskId, itemId)
  return apiFetch(`/tasks/${taskId}/checklist/${itemId}`, { method: 'DELETE' })
}

// ---- work logs ----

export type WorkLogInput = Omit<WorkLog, 'id' | 'taskId' | 'createdAt'>

export function listWorkLogs(taskId: string): Promise<WorkLog[]> {
  if (USE_MOCK) return mock.listWorkLogs(taskId)
  return apiFetch(`/tasks/${taskId}/work-logs`)
}

export function createWorkLog(taskId: string, input: WorkLogInput): Promise<WorkLog> {
  if (USE_MOCK) return mock.createWorkLog(taskId, input)
  return apiFetch(`/tasks/${taskId}/work-logs`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateWorkLog(
  taskId: string,
  logId: string,
  patch: Partial<WorkLogInput>,
): Promise<WorkLog> {
  if (USE_MOCK) return mock.updateWorkLog(taskId, logId, patch)
  return apiFetch(`/tasks/${taskId}/work-logs/${logId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteWorkLog(taskId: string, logId: string): Promise<void> {
  if (USE_MOCK) return mock.deleteWorkLog(taskId, logId)
  return apiFetch(`/tasks/${taskId}/work-logs/${logId}`, { method: 'DELETE' })
}

// ---- attachments ----

export function listAttachments(taskId: string): Promise<Attachment[]> {
  if (USE_MOCK) return mock.listAttachments(taskId)
  return apiFetch(`/tasks/${taskId}/attachments`)
}

export async function uploadAttachment(
  taskId: string,
  file: File,
  description?: string,
): Promise<Attachment> {
  if (USE_MOCK) return mock.uploadAttachment(taskId, file, description)
  const form = new FormData()
  form.append('file', file)
  if (description) form.append('description', description)
  // multipart: bypass apiFetch's JSON Content-Type header
  const res = await fetch(`${API_BASE}/tasks/${taskId}/attachments`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body || res.statusText}`)
  }
  return (await res.json()) as Attachment
}

export function linkAttachment(
  taskId: string,
  path: string,
  description?: string,
): Promise<Attachment> {
  if (USE_MOCK) return mock.linkAttachment(taskId, path, description)
  return apiFetch(`/tasks/${taskId}/attachments/link`, {
    method: 'POST',
    body: JSON.stringify({ path, description }),
  })
}

export function deleteAttachment(taskId: string, attachmentId: string): Promise<void> {
  if (USE_MOCK) return mock.deleteAttachment(taskId, attachmentId)
  return apiFetch(`/tasks/${taskId}/attachments/${attachmentId}`, { method: 'DELETE' })
}

export function attachmentContentUrl(taskId: string, attachmentId: string): string {
  return `${API_BASE}/tasks/${taskId}/attachments/${attachmentId}/content`
}

// ---- estimates ----

export function listEstimates(taskId: string): Promise<Estimate[]> {
  if (USE_MOCK) return mock.listEstimates(taskId)
  return apiFetch(`/tasks/${taskId}/estimates`)
}

export function estimatePrompt(
  taskId: string,
  attachmentIds: string[],
): Promise<EstimatePromptResult> {
  if (USE_MOCK) return mock.estimatePrompt(taskId, attachmentIds)
  return apiFetch(`/tasks/${taskId}/estimate-prompt`, {
    method: 'POST',
    body: JSON.stringify({ attachmentIds }),
  })
}

export function importEstimate(taskId: string, text: string): Promise<Estimate> {
  if (USE_MOCK) return mock.importEstimate(taskId, text)
  return apiFetch(`/tasks/${taskId}/estimates/import`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function applyEstimate(
  taskId: string,
  estimateId: string,
): Promise<ApplyEstimateResult> {
  if (USE_MOCK) return mock.applyEstimate(taskId, estimateId)
  return apiFetch(`/tasks/${taskId}/estimates/${estimateId}/apply`, { method: 'POST' })
}

// ---- career card ----

export async function getCareerCard(taskId: string): Promise<CareerCard | null> {
  if (USE_MOCK) return mock.getCareerCard(taskId)
  try {
    return await apiFetch<CareerCard>(`/tasks/${taskId}/career-card`)
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('API 404')) return null
    throw error
  }
}

export function careerPrompt(taskId: string, confirmedMetrics: string): Promise<string> {
  if (USE_MOCK) return mock.careerPrompt(taskId, confirmedMetrics)
  return apiFetch<{ prompt: string }>(`/tasks/${taskId}/career-card-prompt`, {
    method: 'POST',
    body: JSON.stringify({ attachmentIds: [], confirmedMetrics }),
  }).then((r) => r.prompt)
}

export function importCareerCard(taskId: string, text: string): Promise<CareerCard> {
  if (USE_MOCK) return mock.importCareerCard(taskId, text)
  return apiFetch(`/tasks/${taskId}/career-cards/import`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function patchCareerCard(
  taskId: string,
  patch: Partial<Pick<CareerCard, 'context' | 'role' | 'actions' | 'challenges' | 'outcomes' | 'metrics' | 'skills'>>,
): Promise<CareerCard> {
  if (USE_MOCK) return mock.patchCareerCard(taskId, patch)
  return apiFetch(`/tasks/${taskId}/career-card`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function exportCareerCardMarkdown(taskId: string): Promise<string> {
  if (USE_MOCK) return mock.exportCareerCardMarkdown(taskId)
  const res = await fetch(`${API_BASE}/tasks/${taskId}/career-card/export.md`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body || res.statusText}`)
  }
  return res.text()
}

// ---- aggregated summary ----

export function trackingSummary(): Promise<TrackingSummary[]> {
  if (USE_MOCK) return mock.trackingSummary()
  return apiFetch('/tracking-summary')
}
