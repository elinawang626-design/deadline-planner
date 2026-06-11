import { create } from 'zustand'
import { format } from 'date-fns'
import type { ScheduleSummary } from '../types'

export interface Toast {
  id: number
  kind: 'success' | 'error'
  message: string
}

interface UIState {
  toasts: Toast[]
  pushToast: (kind: Toast['kind'], message: string) => void
  /** Shared current date ("yyyy-MM-dd") for day/week/month navigation. */
  currentDate: string
  setCurrentDate: (date: string) => void
  lastSummary: ScheduleSummary | null
  setLastSummary: (summary: ScheduleSummary) => void
}

const TOAST_DURATION_MS = 4000
let nextToastId = 1

export const useUI = create<UIState>((set) => ({
  toasts: [],
  pushToast: (kind, message) => {
    const id = nextToastId++
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    setTimeout(
      () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      TOAST_DURATION_MS,
    )
  },
  currentDate: format(new Date(), 'yyyy-MM-dd'),
  setCurrentDate: (date) => set({ currentDate: date }),
  lastSummary: null,
  setLastSummary: (summary) => set({ lastSummary: summary }),
}))
