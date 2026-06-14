import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createAvailability,
  deleteAvailability,
  getSettings,
  listAvailability,
  saveSettings,
  updateAvailability,
} from '../api/availability'
import { useUI } from '../store/ui'
import { useT } from '../i18n'
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from '../lib/labels'
import { DEFAULT_SETTINGS, toSettings, type AvailabilityWindow } from '../types'

const timeCls = 'rounded-md border border-gray-300 px-1 py-0.5 text-sm'

function AddWindow({ onAdd }: { onAdd: (start: string, end: string) => void }) {
  const t = useT()
  const [start, setStart] = useState('19:00')
  const [end, setEnd] = useState('22:00')
  return (
    <span className="flex items-center gap-1 text-xs">
      <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={timeCls} />
      <span>–</span>
      <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={timeCls} />
      <button
        onClick={() => {
          if (start < end) onAdd(start, end)
        }}
        className="rounded-md border border-gray-300 px-2 py-0.5 hover:bg-gray-50"
      >
        {t('avail.add')}
      </button>
    </span>
  )
}

export default function AvailabilityPage() {
  const t = useT()
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const { data: windows = [] } = useQuery({ queryKey: ['availability'], queryFn: listAvailability })
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const [maxHours, setMaxHours] = useState('6')
  const [syncedSettings, setSyncedSettings] = useState(settings)
  if (settings && settings !== syncedSettings) {
    setSyncedSettings(settings)
    setMaxHours(String(settings.dailyMaxPlannedHours))
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['availability'] })
  const create = useMutation({ mutationFn: createAvailability, onSuccess: invalidate })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<AvailabilityWindow> }) =>
      updateAvailability(id, patch),
    onSuccess: invalidate,
  })
  const remove = useMutation({ mutationFn: deleteAvailability, onSuccess: invalidate })
  const saveMax = useMutation({
    mutationFn: () => {
      const base = settings ? toSettings(settings) : DEFAULT_SETTINGS
      return saveSettings({ ...base, dailyMaxPlannedHours: Number(maxHours) || 6 })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      pushToast('success', t('settings.saved'))
    },
  })

  const copyDay = (from: number, to: number) => {
    const source = windows.filter((w) => w.weekday === from)
    source.forEach((w) => create.mutate({ weekday: to, startTime: w.startTime, endTime: w.endTime }))
    pushToast('success', t('avail.copied', { from: WEEKDAY_LABELS[from], to: WEEKDAY_LABELS[to] }))
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="mb-1 text-lg font-semibold">{t('avail.title')}</h2>
      <p className="mb-4 text-sm text-gray-500">{t('avail.intro')}</p>
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-3">
        <label htmlFor="max-hours" className="text-sm">{t('avail.maxHours')}</label>
        <input
          id="max-hours"
          type="number"
          min="1"
          max="24"
          value={maxHours}
          onChange={(e) => setMaxHours(e.target.value)}
          className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        <button
          onClick={() => saveMax.mutate()}
          className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700"
        >
          {t('common.save')}
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {WEEKDAY_ORDER.map((weekday) => {
          const dayWindows = windows.filter((w) => w.weekday === weekday)
          return (
            <div key={weekday} className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{WEEKDAY_LABELS[weekday]}</h3>
                <div className="flex items-center gap-2">
                  <AddWindow
                    onAdd={(startTime, endTime) => create.mutate({ weekday, startTime, endTime })}
                  />
                  {dayWindows.length > 0 && (
                    <select
                      className="rounded-md border border-gray-300 px-1 py-1 text-xs"
                      value=""
                      onChange={(e) => {
                        if (e.target.value !== '') copyDay(weekday, Number(e.target.value))
                      }}
                    >
                      <option value="">{t('avail.copyTo')}</option>
                      {WEEKDAY_ORDER.filter((d) => d !== weekday).map((d) => (
                        <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              {dayWindows.length === 0 ? (
                <p className="text-xs text-gray-400">{t('avail.useDefault')}</p>
              ) : (
                dayWindows.map((w) => (
                  <div key={w.id} className="mb-1 flex items-center gap-2 text-sm">
                    <input
                      type="time"
                      defaultValue={w.startTime}
                      onBlur={(e) => {
                        if (e.target.value && e.target.value !== w.startTime) {
                          update.mutate({ id: w.id, patch: { startTime: e.target.value } })
                        }
                      }}
                      className={timeCls}
                    />
                    <span>–</span>
                    <input
                      type="time"
                      defaultValue={w.endTime}
                      onBlur={(e) => {
                        if (e.target.value && e.target.value !== w.endTime) {
                          update.mutate({ id: w.id, patch: { endTime: e.target.value } })
                        }
                      }}
                      className={timeCls}
                    />
                    <button onClick={() => remove.mutate(w.id)} className="text-xs text-red-600 hover:underline">
                      {t('common.delete')}
                    </button>
                  </div>
                ))
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
