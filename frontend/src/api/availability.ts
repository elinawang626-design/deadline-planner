import { USE_MOCK, apiFetch } from './client'
import * as mock from './mock'
import type { AvailabilityWindow, Settings, SettingsResponse } from '../types'

export function listAvailability(): Promise<AvailabilityWindow[]> {
  if (USE_MOCK) return mock.listAvailability()
  return apiFetch('/availability') // TODO(backend): GET /api/availability
}

export function createAvailability(
  input: Omit<AvailabilityWindow, 'id'>,
): Promise<AvailabilityWindow> {
  if (USE_MOCK) return mock.createAvailability(input)
  // TODO(backend): POST /api/availability
  return apiFetch('/availability', { method: 'POST', body: JSON.stringify(input) })
}

export function updateAvailability(
  id: string,
  patch: Partial<AvailabilityWindow>,
): Promise<AvailabilityWindow> {
  if (USE_MOCK) return mock.updateAvailability(id, patch)
  // TODO(backend): PATCH /api/availability/:id
  return apiFetch(`/availability/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteAvailability(id: string): Promise<void> {
  if (USE_MOCK) return mock.deleteAvailability(id)
  // TODO(backend): DELETE /api/availability/:id
  return apiFetch(`/availability/${id}`, { method: 'DELETE' })
}

export function getSettings(): Promise<SettingsResponse> {
  if (USE_MOCK) return mock.getSettings()
  return apiFetch('/settings')
}

export function saveSettings(settings: Settings): Promise<SettingsResponse> {
  if (USE_MOCK) return mock.saveSettings(settings)
  return apiFetch('/settings', { method: 'PUT', body: JSON.stringify(settings) })
}
