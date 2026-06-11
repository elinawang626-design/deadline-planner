import { USE_MOCK, apiFetch } from './client'
import * as mock from './mock'
import type { Task } from '../types'

export type { TaskCreate } from './mock'
import type { TaskCreate } from './mock'

export function listTasks(): Promise<Task[]> {
  if (USE_MOCK) return mock.listTasks()
  return apiFetch('/tasks') // TODO(backend): GET /api/tasks
}

export function createTask(input: TaskCreate): Promise<Task> {
  if (USE_MOCK) return mock.createTask(input)
  // TODO(backend): POST /api/tasks
  return apiFetch('/tasks', { method: 'POST', body: JSON.stringify(input) })
}

export function updateTask(id: string, patch: Partial<Task>): Promise<Task> {
  if (USE_MOCK) return mock.updateTask(id, patch)
  // TODO(backend): PATCH /api/tasks/:id
  return apiFetch(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteTask(id: string): Promise<void> {
  if (USE_MOCK) return mock.deleteTask(id)
  // TODO(backend): DELETE /api/tasks/:id
  return apiFetch(`/tasks/${id}`, { method: 'DELETE' })
}
