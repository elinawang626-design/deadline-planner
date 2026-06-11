import { useUI } from '../../store/ui'

export function Toaster() {
  const toasts = useUI((s) => s.toasts)
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`rounded-md px-4 py-2 text-sm shadow-lg ${
            t.kind === 'success' ? 'bg-gray-900 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
