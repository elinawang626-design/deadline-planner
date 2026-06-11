import { NavLink, Route, Routes } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { regenerateSchedule } from './api/schedule'
import { USE_MOCK } from './api/client'
import { useUI } from './store/ui'
import { Toaster } from './components/ui/Toaster'
import TodayPage from './pages/TodayPage'
import DayPage from './pages/DayPage'
import WeekPage from './pages/WeekPage'
import MonthPage from './pages/MonthPage'
import TasksPage from './pages/TasksPage'
import AvailabilityPage from './pages/AvailabilityPage'
import AIImportPage from './pages/AIImportPage'

const NAV = [
  { to: '/', label: '今天' },
  { to: '/day', label: '日视图' },
  { to: '/week', label: '周视图' },
  { to: '/month', label: '月视图' },
  { to: '/tasks', label: '任务' },
  { to: '/availability', label: '可用时间' },
  { to: '/ai-import', label: 'AI 导入' },
]

function RegenerateButton() {
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
        `已重新生成：新增 ${summary.createdBlocks} 块，移除 ${summary.removedBlocks} 块，${summary.warnings.length} 条警告`,
      )
    },
    onError: (error: unknown) =>
      pushToast('error', error instanceof Error ? error.message : '重新生成失败'),
  })
  return (
    <button
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
    >
      {mutation.isPending ? '生成中…' : '重新生成日程'}
    </button>
  )
}

export default function App() {
  return (
    <div className="flex min-h-screen">
      <aside className="w-44 shrink-0 border-r border-gray-200 bg-white p-4">
        <h1 className="mb-6 text-base font-bold">Deadline Planner</h1>
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
              {item.label}
            </NavLink>
          ))}
        </nav>
        {USE_MOCK && (
          <p className="mt-6 rounded-md bg-amber-50 p-2 text-xs text-amber-700">
            Mock 数据模式（无后端，数据存于浏览器）
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
            <Route path="/availability" element={<AvailabilityPage />} />
            <Route path="/ai-import" element={<AIImportPage />} />
          </Routes>
        </main>
      </div>
      <Toaster />
    </div>
  )
}
