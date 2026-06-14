import { useEffect } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { regenerateSchedule } from './api/schedule'
import { getSettings } from './api/availability'
import { USE_MOCK } from './api/client'
import { useUI } from './store/ui'
import { useLang, useT } from './i18n'
import { Toaster } from './components/ui/Toaster'
import TodayPage from './pages/TodayPage'
import DayPage from './pages/DayPage'
import WeekPage from './pages/WeekPage'
import MonthPage from './pages/MonthPage'
import TasksPage from './pages/TasksPage'
import TaskDetailPage from './pages/TaskDetailPage'
import AvailabilityPage from './pages/AvailabilityPage'
import AIImportPage from './pages/AIImportPage'
import SettingsPage from './pages/SettingsPage'

const NAV = [
  { to: '/', key: 'nav.today' },
  { to: '/day', key: 'nav.day' },
  { to: '/week', key: 'nav.week' },
  { to: '/month', key: 'nav.month' },
  { to: '/tasks', key: 'nav.tasks' },
  { to: '/availability', key: 'nav.availability' },
  { to: '/ai-import', key: 'nav.ai' },
  { to: '/settings', key: 'nav.settings' },
]

function RegenerateButton() {
  const t = useT()
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const setLastSummary = useUI((s) => s.setLastSummary)
  const mutation = useMutation({
    mutationFn: regenerateSchedule,
    onSuccess: (summary) => {
      setLastSummary(summary)
      queryClient.invalidateQueries({ queryKey: ['blocks'] })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      pushToast(
        'success',
        t('app.regenerated', {
          created: summary.createdBlocks,
          removed: summary.removedBlocks,
          warnings: summary.warnings.length,
        }) +
          (summary.totalUnscheduledMinutes > 0
            ? t('app.regeneratedUnscheduled', { minutes: summary.totalUnscheduledMinutes })
            : ''),
      )
    },
    onError: (error: unknown) =>
      pushToast('error', error instanceof Error ? error.message : t('app.regenerateFailed')),
  })
  return (
    <button
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
    >
      {mutation.isPending ? t('app.regenerating') : t('app.regenerate')}
    </button>
  )
}

export default function App() {
  const t = useT()
  const setLang = useLang((s) => s.setLang)
  // Server settings are the source of truth for language; sync once loaded.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  useEffect(() => {
    if (settings?.language) setLang(settings.language)
  }, [settings?.language, setLang])

  return (
    <div className="flex min-h-screen">
      <aside className="w-44 shrink-0 border-r border-gray-200 bg-white p-4">
        <h1 className="mb-6 text-base font-bold">{t('app.title')}</h1>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm ${
                  isActive
                    ? 'bg-blue-50 font-medium text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100'
                }`
              }
            >
              {t(item.key)}
            </NavLink>
          ))}
        </nav>
        {USE_MOCK && (
          <p className="mt-6 rounded-md bg-amber-50 p-2 text-xs text-amber-700">
            {t('app.mockBanner')}
          </p>
        )}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end border-b border-gray-200 bg-white px-6 py-3">
          <RegenerateButton />
        </header>
        <main className="flex-1 p-6">
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/day" element={<DayPage />} />
            <Route path="/week" element={<WeekPage />} />
            <Route path="/month" element={<MonthPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
            <Route path="/availability" element={<AvailabilityPage />} />
            <Route path="/ai-import" element={<AIImportPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
      <Toaster />
    </div>
  )
}
