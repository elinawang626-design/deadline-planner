// TODO(backend): set VITE_USE_MOCK=false (and VITE_API_BASE if needed) once the
// backend exposes the HTTP API. Mock mode is the default so the frontend works
// standalone against localStorage.
export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false'

export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'
const BASE = API_BASE

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body || res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
