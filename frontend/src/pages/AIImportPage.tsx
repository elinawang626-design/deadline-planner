import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  generatePlanPrompt,
  importPlan,
  runPlan,
  validatePlanOutput,
} from '../api/aiimport'
import { getSettings, saveSettings } from '../api/availability'
import { useUI } from '../store/ui'
import { useT } from '../i18n'
import { toSettings } from '../types'
import type { AiMode, PlanChange, PlanMode, PlanPreview, SettingsResponse } from '../types'

const PLAN_MODES: PlanMode[] = ['ai_plan', 'ai_optimize', 'tasks_only']

const textareaCls =
  'h-40 w-full rounded-md border border-gray-300 p-2 font-mono text-xs focus:border-blue-500 focus:outline-none'
const btnCls = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50'
const primaryBtnCls =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50'
const sectionCls = 'rounded-lg border border-gray-200 bg-white p-4'

const KIND_COLORS: Record<string, string> = {
  add: 'bg-green-100 text-green-700',
  update: 'bg-blue-100 text-blue-700',
  move: 'bg-amber-100 text-amber-700',
  delete: 'bg-red-100 text-red-700',
  remove: 'bg-red-100 text-red-700',
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return format(new Date(value), 'MM-dd HH:mm')
  }
  return String(value)
}

interface ChangeRowProps {
  change: PlanChange
  checked: boolean
  blockedByDependency: boolean
  onToggle: (changeId: string) => void
}

function ChangeRow({ change, checked, blockedByDependency, onToggle }: ChangeRowProps) {
  const t = useT()
  const suffix = change.kind.split('_').pop() ?? ''
  return (
    <li
      className={`rounded-md border p-2 ${checked ? 'border-gray-200' : 'border-gray-100 bg-gray-50 opacity-70'}`}
    >
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          disabled={blockedByDependency}
          onChange={() => onToggle(change.changeId)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${KIND_COLORS[suffix] ?? 'bg-gray-100 text-gray-700'}`}
            >
              {t(`kind.${change.kind}`)}
            </span>
            <span>{change.summary}</span>
          </div>
          {change.fields.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-gray-500">
              {change.fields.map((f) => (
                <li key={f.field}>
                  {f.field}：
                  {f.old !== undefined && f.old !== null && (
                    <>
                      <span className="line-through">{formatValue(f.old)}</span>
                      {' → '}
                    </>
                  )}
                  <span className="text-gray-700">{formatValue(f.new)}</span>
                </li>
              ))}
            </ul>
          )}
          {blockedByDependency && (
            <p className="mt-1 text-xs text-amber-600">{t('ai.depBlocked')}</p>
          )}
        </div>
      </label>
    </li>
  )
}

export default function AIImportPage() {
  const t = useT()
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const setLastSummary = useUI((s) => s.setLastSummary)
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: getSettings })

  const [uiMode, setUiMode] = useState<AiMode>('manual')
  const [planMode, setPlanMode] = useState<PlanMode>('ai_plan')
  const [requirements, setRequirements] = useState('')
  const [prompt, setPrompt] = useState('')
  const [output, setOutput] = useState('')
  // text used for the actual import: pasted reply (manual) or raw API output (api)
  const [importText, setImportText] = useState('')
  const [preview, setPreview] = useState<PlanPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // Adopt the saved default mode once settings (re)load (render-phase sync).
  const [syncedSettings, setSyncedSettings] = useState<SettingsResponse | undefined>(undefined)
  if (settings && settings !== syncedSettings) {
    setSyncedSettings(settings)
    setUiMode(settings.aiMode)
  }

  const clearPreview = () => {
    setPreview(null)
    setSelected(new Set())
    setImportText('')
  }

  const switchUiMode = (mode: AiMode) => {
    setUiMode(mode)
    clearPreview()
    if (settings && settings.aiMode !== mode) {
      void saveSettings({ ...toSettings(settings), aiMode: mode }).then(() =>
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
      )
    }
  }

  const onGenerate = async () => {
    setBusy(true)
    try {
      setPrompt(await generatePlanPrompt(planMode, requirements))
    } catch (error: unknown) {
      pushToast('error', error instanceof Error ? error.message : t('ai.generateFailed'))
    } finally {
      setBusy(false)
    }
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      pushToast('success', t('common.copied'))
    } catch {
      pushToast('error', t('ai.copyFailed'))
    }
  }

  const applyPreview = (result: PlanPreview, text: string) => {
    setPreview(result)
    setImportText(text)
    setSelected(new Set(result.changes.map((c) => c.changeId)))
    if (result.ok) pushToast('success', t('ai.parseOk', { count: result.changes.length }))
  }

  const onValidate = async (text = output) => {
    setBusy(true)
    try {
      applyPreview(await validatePlanOutput(text, planMode), text)
    } finally {
      setBusy(false)
    }
  }

  const onRun = async () => {
    setBusy(true)
    try {
      const result = await runPlan(planMode, requirements)
      applyPreview(result, result.rawOutput)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('ai.runFailed')
      pushToast('error', message === 'MOCK_NO_BACKEND' ? t('ai.mockApiDisabled') : message)
    } finally {
      setBusy(false)
    }
  }

  const toggleChange = (changeId: string) => {
    if (!preview) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(changeId)) {
        next.delete(changeId)
        let changed = true
        while (changed) {
          changed = false
          for (const change of preview.changes) {
            if (next.has(change.changeId) && change.dependsOn.some((dep) => !next.has(dep))) {
              next.delete(change.changeId)
              changed = true
            }
          }
        }
      } else {
        next.add(changeId)
        for (const dep of preview.changes.find((c) => c.changeId === changeId)?.dependsOn ?? []) {
          next.add(dep)
        }
      }
      return next
    })
  }

  const onImport = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const acceptedAll = selected.size === preview.changes.length
      const result = await importPlan(
        importText,
        planMode,
        preview.previewVersion,
        acceptedAll ? undefined : [...selected],
      )
      if (result.scheduleSummary) setLastSummary(result.scheduleSummary)
      for (const key of ['tasks', 'blocks', 'availability', 'fixed-events']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      pushToast(
        'success',
        t('ai.applied', { applied: result.applied }) +
          (result.rejected ? t('ai.appliedRejected', { rejected: result.rejected }) : '') +
          (result.scheduleSummary ? t('ai.appliedRescheduled') : ''),
      )
      setOutput('')
      clearPreview()
    } catch (error: unknown) {
      pushToast('error', error instanceof Error ? error.message : t('ai.importFailed'))
    } finally {
      setBusy(false)
    }
  }

  const activeProvider = settings?.activeProvider ?? 'openai'
  const providerModel = settings?.providers[activeProvider]?.model ?? ''
  const keyConfigured = settings?.configured[activeProvider] ?? false

  const modeTab = (mode: AiMode, label: string) => (
    <button
      key={mode}
      onClick={() => switchUiMode(mode)}
      className={`rounded-md px-3 py-1.5 text-sm ${
        uiMode === mode ? 'bg-blue-600 text-white' : 'border border-gray-300 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('ai.title')}</h2>
        <div className="flex gap-2">
          {modeTab('manual', t('ai.modeManual'))}
          {modeTab('api', t('ai.modeApi'))}
        </div>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        {uiMode === 'manual' ? t('ai.subtitleManual') : t('ai.subtitleApi')}
      </p>

      <div className="flex flex-col gap-4">
        <section className={sectionCls}>
          <h3 className="mb-2 text-sm font-semibold">{t('ai.planMode')}</h3>
          <div className="mb-3 flex flex-col gap-2">
            {PLAN_MODES.map((m) => (
              <label key={m} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="plan-mode"
                  className="mt-0.5"
                  checked={planMode === m}
                  onChange={() => {
                    setPlanMode(m)
                    clearPreview()
                  }}
                />
                <span>
                  <span className="font-medium">{t(`mode.${m}`)}</span>
                  <span className="ml-2 text-xs text-gray-500">{t(`ai.hint.${m}`)}</span>
                </span>
              </label>
            ))}
          </div>
          <textarea
            className={`${textareaCls} h-20`}
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder={t('ai.requirementsPlaceholder')}
          />
        </section>

        {uiMode === 'manual' ? (
          <>
            <section className={sectionCls}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t('ai.promptSection')}</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => void onGenerate()}
                    disabled={busy}
                    className={`${btnCls} disabled:opacity-50`}
                  >
                    {t('ai.generatePrompt')}
                  </button>
                  <button
                    onClick={() => void onCopy()}
                    disabled={!prompt}
                    className={`${btnCls} disabled:opacity-50`}
                  >
                    {t('ai.copyPrompt')}
                  </button>
                </div>
              </div>
              <textarea
                className={textareaCls}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </section>

            <section className={sectionCls}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t('ai.pasteSection')}</h3>
                <button
                  onClick={() => void onValidate()}
                  disabled={busy || !output}
                  className={`${btnCls} disabled:opacity-50`}
                >
                  {t('ai.parsePreview')}
                </button>
              </div>
              <textarea
                className={textareaCls}
                value={output}
                onChange={(e) => {
                  setOutput(e.target.value)
                  clearPreview()
                }}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text')
                  if (text.trim()) void onValidate(text)
                }}
                placeholder={t('ai.pastePlaceholder')}
              />
            </section>
          </>
        ) : (
          <section className={sectionCls}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t('ai.apiSection')}</h3>
              <button
                onClick={() => void onRun()}
                disabled={busy || !keyConfigured}
                className={primaryBtnCls}
              >
                {busy ? t('ai.running') : t('ai.runApi')}
              </button>
            </div>
            <p className="text-xs text-gray-500">
              {t('ai.providerModel', {
                provider: t(`settings.provider.${activeProvider}`),
                model: providerModel || '—',
              })}
            </p>
            {!keyConfigured && (
              <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                {t('ai.keyMissing')}
              </p>
            )}
          </section>
        )}

        {preview && (
          <section className={sectionCls}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {t('ai.previewSection', { count: preview.changes.length })}
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={() => setSelected(new Set(preview.changes.map((c) => c.changeId)))}
                  className={btnCls}
                >
                  {t('common.all')}
                </button>
                <button
                  onClick={() => void onImport()}
                  disabled={busy || !preview.ok || selected.size === 0}
                  className={primaryBtnCls}
                >
                  {t('ai.applySelected', { count: selected.size })}
                </button>
              </div>
            </div>
            {preview.errors.length > 0 && (
              <>
                <ul className="mb-2 list-inside list-disc rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                  {preview.errors.map((error, i) => (
                    <li key={i}>{error}</li>
                  ))}
                </ul>
                {uiMode === 'api' && (
                  <button onClick={() => switchUiMode('manual')} className={`${btnCls} mb-2`}>
                    {t('ai.switchToManual')}
                  </button>
                )}
              </>
            )}
            {preview.warnings.length > 0 && (
              <ul className="mb-2 list-inside list-disc rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                {preview.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            )}
            {preview.useLocalScheduler && (
              <p className="mb-2 text-xs text-gray-500">{t('ai.localSchedulerNote')}</p>
            )}
            {preview.changes.length === 0 ? (
              <p className="text-sm text-gray-500">{t('ai.noChanges')}</p>
            ) : (
              <ul className="space-y-2">
                {preview.changes.map((change) => (
                  <ChangeRow
                    key={change.changeId}
                    change={change}
                    checked={selected.has(change.changeId)}
                    blockedByDependency={change.dependsOn.some((dep) => !selected.has(dep))}
                    onToggle={toggleChange}
                  />
                ))}
              </ul>
            )}
            {preview.keptBlocks.length > 0 && (
              <details className="mt-3 text-xs text-gray-500">
                <summary className="cursor-pointer">
                  {t('ai.keptBlocks', { count: preview.keptBlocks.length })}
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {preview.keptBlocks.map((b) => (
                    <li key={b.id}>
                      {format(new Date(b.startAt), 'MM-dd HH:mm')}–
                      {format(new Date(b.endAt), 'HH:mm')}（{t(`kept.${b.reason}`)}）
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
