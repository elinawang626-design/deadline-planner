import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  attachmentContentUrl,
  deleteAttachment,
  linkAttachment,
  listAttachments,
  uploadAttachment,
} from '../../api/track'
import { USE_MOCK } from '../../api/client'
import { useUI } from '../../store/ui'
import { useT } from '../../i18n'
import type { ExtractionStatus } from '../../types'

const STATUS_COLOR: Record<ExtractionStatus, string> = {
  ok: 'bg-green-50 text-green-700',
  failed: 'bg-red-50 text-red-700',
  unsupported: 'bg-gray-100 text-gray-500',
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function AttachmentSection({ taskId }: { taskId: string }) {
  const t = useT()
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const fileInput = useRef<HTMLInputElement>(null)
  const [linkPath, setLinkPath] = useState('')

  const { data: attachments = [] } = useQuery({
    queryKey: ['attachments', taskId],
    queryFn: () => listAttachments(taskId),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['attachments', taskId] })
    queryClient.invalidateQueries({ queryKey: ['tracking-summary'] })
  }
  const onError = (error: unknown) =>
    pushToast('error', error instanceof Error ? error.message : t('common.opFailed'))

  const upload = useMutation({
    mutationFn: (file: File) => uploadAttachment(taskId, file),
    onSuccess: () => {
      if (fileInput.current) fileInput.current.value = ''
      invalidate()
    },
    onError,
  })
  const link = useMutation({
    mutationFn: (path: string) => linkAttachment(taskId, path),
    onSuccess: () => {
      setLinkPath('')
      invalidate()
    },
    onError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteAttachment(taskId, id),
    onSuccess: invalidate,
    onError,
  })

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold">{t('attach.title')}</h3>
      {USE_MOCK && (
        <p className="mb-2 rounded-md bg-amber-50 p-2 text-xs text-amber-700">
          {t('attach.mockNote')}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {attachments.map((att) => (
          <li key={att.id} className="flex flex-wrap items-center gap-2 rounded-md bg-gray-50 p-2 text-xs">
            <span className="font-medium">{att.displayName}</span>
            <span className="rounded px-1.5 py-0.5 text-[10px] text-gray-500">
              {att.storageMode === 'copy' ? t('attach.copyMode') : t('attach.linkMode')}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_COLOR[att.extractionStatus]}`}>
              {t(`attach.status.${att.extractionStatus}`)}
            </span>
            {att.sizeBytes > 0 && <span className="text-gray-400">{fmtSize(att.sizeBytes)}</span>}
            {att.storageMode === 'link' && att.originalPath && (
              <span className="max-w-xs truncate text-gray-400" title={att.originalPath}>
                {att.originalPath}
              </span>
            )}
            <span className="ml-auto flex gap-2">
              {!USE_MOCK && (
                <a
                  href={attachmentContentUrl(taskId, att.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  {t('common.view')}
                </a>
              )}
              <button
                onClick={() => {
                  const hint =
                    att.storageMode === 'copy'
                      ? t('attach.confirmDeleteCopy')
                      : t('attach.confirmDeleteLink')
                  if (window.confirm(t('attach.confirmDelete', { name: att.displayName, hint }))) {
                    remove.mutate(att.id)
                  }
                }}
                className="text-red-500 hover:underline"
              >
                {t('common.delete')}
              </button>
            </span>
          </li>
        ))}
        {attachments.length === 0 && (
          <p className="text-xs text-gray-400">{t('attach.empty')}</p>
        )}
      </ul>
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            className="text-xs"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) upload.mutate(file)
            }}
          />
          <span className="text-xs text-gray-400">{t('attach.uploadHint')}</span>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (linkPath.trim()) link.mutate(linkPath.trim())
          }}
        >
          <input
            value={linkPath}
            onChange={(e) => setLinkPath(e.target.value)}
            placeholder={t('attach.linkPlaceholder')}
            className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={!linkPath.trim() || link.isPending}
            className="rounded-md bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {t('attach.link')}
          </button>
        </form>
      </div>
    </section>
  )
}
