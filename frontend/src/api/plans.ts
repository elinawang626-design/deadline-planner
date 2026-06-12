import { USE_MOCK, apiFetch } from './client'
import * as mock from './mock'
import type { PlanCreate, PlanCreateResult } from '../types'

/** Atomic: optionally create the task, then its locked manual block. */
export function createPlan(input: PlanCreate): Promise<PlanCreateResult> {
  if (USE_MOCK) return mock.createPlan(input)
  return apiFetch('/plans', { method: 'POST', body: JSON.stringify(input) })
}
