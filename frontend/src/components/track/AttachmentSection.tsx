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
import type { ExtractionStatus } from '../../types'

const STATUS_LABELS: Record<ExtractionStatus, string> = {
  ok: '已解析',
  failed: '解析失败',
  unsupported: '不支持解析',
}

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
    pushToast('error', error instanceof Error ? error.message : '操作失败')

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
      <h3 className="mb-3 text-sm font-semibold">附件资料</h3>
      {USE_MOCK && (
        <p className="mb-2 rounded-md bg-amber-50 p-2 text-xs text-amber-700">
          Mock 模式只保存附件元数据，不复制或解析文件；解析与估时引用需要后端模式。
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {attachments.map((att) => (
          <li key={att.id} className="flex flex-wrap items-center gap-2 rounded-md bg-gray-50 p-2 text-xs">
            <span className="font-medium">{att.displayName}</span>
            <span className="rounded px-1.5 py-0.5 text-[10px] text-gray-500">
              {att.storageMode === 'copy' ? '应用副本' : '链接原文件'}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_COLOR[att.extractionStatus]}`}>
              {STATUS_LABELS[att.extractionStatus]}
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
                  查看
                </a>
              )}
              <button
                onClick={() => {
                  const hint =
                    att.storageMode === 'copy'
                      ? '将删除应用内副本。'
                      : '只删除记录，原文件保留。'
                  if (window.confirm(`删除附件「${att.displayName}」？${hint}`)) {
                    remove.mutate(att.id)
                  }
                }}
                className="text-red-500 hover:underline"
              >
                删除
              </button>
            </span>
          </li>
        ))}
        {attachments.length === 0 && (
          <p className="text-xs text-gray-400">还没有附件。支持 TXT / Markdown / PDF / DOCX 解析。</p>
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
          <span className="text-xs text-gray-400">上传（复制到应用目录）</span>
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
            placeholder="或输入本机文件绝对路径（仅记录链接，不复制）…"
            className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={!linkPath.trim() || link.isPending}
            className="rounded-md bg-gray-700 px-3 py-1 text-xs text-white hover:bg-gray-800 disabled:opacity-50"
          >
            链接
          </button>
        </form>
      </div>
    </section>
  )
}
