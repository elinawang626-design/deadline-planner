import { USE_MOCK, apiFetch } from './client'
import * as mock from './mock'
import type { FixedEvent, ScheduleSummary, ScheduledBlock } from '../types'

export function listBlocks(start?: string, end?: string): Promise<ScheduledBlock[]> {
  if (USE_MOCK) return mock.listBlocks(start, end)
  const params = new URLSearchParams()
  if (start) params.set('start', start)
  if (end) params.set('end', end)
  // TODO(backend): GET /api/schedule/blocks?start=...&end=...
  return apiFetch(`/schedule/blocks?${params}`)
}

export function updateBlock(
  id: string,
  patch: Partial<ScheduledBlock>,
): Promise<ScheduledBlock> {
  if (USE_MOCK) return mock.updateBlock(id, patch)
  // TODO(backend): PATCH /api/schedule/blocks/:id
  return apiFetch(`/schedule/blocks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteBlock(id: string): Promise<void> {
  if (USE_MOCK) return mock.deleteBlock(id)
  // TODO(backend): DELETE /api/schedule/blocks/:id
  return apiFetch(`/schedule/blocks/${id}`, { method: 'DELETE' })
}

export function regenerateSchedule(): Promise<ScheduleSummary> {
  if (USE_MOCK) return mock.regenerateSchedule()
  // TODO(backend): POST /api/schedule/regenerate
  return apiFetch('/schedule/regenerate', { method: 'POST' })
}

export function listFixedEvents(): Promise<FixedEvent[]> {
  if (USE_MOCK) return mock.listFixedEvents()
  // TODO(backend): expose fixed events endpoint (e.g. GET /api/fixed-events)
  return apiFetch('/fixed-events')
}
