import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getSettings, saveSettings } from '../api/availability'
import { deleteProviderKey, saveProviderKey, testProviderKey } from '../api/aiimport'
import { useUI } from '../store/ui'
import { useLang, useT } from '../i18n'
import { DEFAULT_SETTINGS, PROVIDER_NAMES, toSettings } from '../types'
import type { AiMode, Language, ProviderName, Settings, SettingsResponse } from '../types'

const sectionCls = 'rounded-lg border border-gray-200 bg-white p-4'
const inputCls =
  'w-full rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none'
const btnCls =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50'
const primaryBtnCls =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50'

function errMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message === 'MOCK_NO_BACKEND' ? fallback : error.message
  }
  return fallback
}

export default function SettingsPage() {
  const t = useT()
  const queryClient = useQueryClient()
  const pushToast = useUI((s) => s.pushToast)
  const setLang = useLang((s) => s.setLang)

  const { data } = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS)
  const [configured, setConfigured] = useState<Record<ProviderName, boolean>>({
    openai: false,
    deepseek: false,
    claude: false,
  })
  const [keyInputs, setKeyInputs] = useState<Record<ProviderName, string>>({
    openai: '',
    deepseek: '',
    claude: '',
  })

  // Seed the editable form from server data once it (re)loads (render-phase sync).
  const [synced, setSynced] = useState<SettingsResponse | undefined>(undefined)
  if (data && data !== synced) {
    setSynced(data)
    setForm(toSettings(data))
    setConfigured(data.configured)
  }

  const saveSettingsMutation = useMutation({
    mutationFn: () => saveSettings(form),
    onSuccess: (saved) => {
      setLang(saved.language)
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      pushToast('success', t('settings.saved'))
    },
    onError: (error) => pushToast('error', errMessage(error, t('common.saveFailed'))),
  })

  const saveKeyMutation = useMutation({
    mutationFn: (provider: ProviderName) =>
      saveProviderKey(provider, keyInputs[provider].trim()),
    onSuccess: (res, provider) => {
      setConfigured(res.configured)
      setKeyInputs((prev) => ({ ...prev, [provider]: '' }))
      pushToast('success', t('settings.keySaved'))
    },
    onError: (error) => pushToast('error', errMessage(error, t('ai.mockApiDisabled'))),
  })

  const deleteKeyMutation = useMutation({
    mutationFn: (provider: ProviderName) => deleteProviderKey(provider),
    onSuccess: (res) => {
      setConfigured(res.configured)
      pushToast('success', t('settings.keyDeleted'))
    },
    onError: (error) => pushToast('error', errMessage(error, t('ai.mockApiDisabled'))),
  })

  const testKeyMutation = useMutation({
    mutationFn: (provider: ProviderName) => testProviderKey(provider),
    onSuccess: () => pushToast('success', t('settings.testOk')),
    onError: (error) =>
      pushToast(
        'error',
        `${t('settings.testFailed')}：${errMessage(error, t('ai.mockApiDisabled'))}`,
      ),
  })

  const onLanguageChange = (language: Language) => {
    setForm((f) => ({ ...f, language }))
    setLang(language) // instant UI switch; persisted on Save
  }

  const setProviderField = (
    provider: ProviderName,
    field: 'baseUrl' | 'model',
    value: string,
  ) => {
    setForm((f) => ({
      ...f,
      providers: { ...f.providers, [provider]: { ...f.providers[provider], [field]: value } },
    }))
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h2 className="text-lg font-semibold">{t('settings.title')}</h2>

      <section className={sectionCls}>
        <h3 className="mb-3 text-sm font-semibold">{t('settings.langSection')}</h3>
        <div className="flex gap-4">
          {(['zh-CN', 'en-US'] as Language[]).map((lang) => (
            <label key={lang} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="language"
                checked={form.language === lang}
                onChange={() => onLanguageChange(lang)}
              />
              {lang === 'zh-CN' ? t('settings.langZh') : t('settings.langEn')}
            </label>
          ))}
        </div>
      </section>

      <section className={sectionCls}>
        <h3 className="mb-3 text-sm font-semibold">{t('settings.aiSection')}</h3>
        <div className="mb-3 flex flex-col gap-2">
          <span className="text-xs text-gray-500">{t('settings.aiMode')}</span>
          {(['manual', 'api'] as AiMode[]).map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="aiMode"
                checked={form.aiMode === m}
                onChange={() => setForm((f) => ({ ...f, aiMode: m }))}
              />
              {m === 'manual' ? t('settings.aiModeManual') : t('settings.aiModeApi')}
            </label>
          ))}
        </div>
        <div className="mb-3 flex flex-col gap-2">
          <span className="text-xs text-gray-500">{t('settings.activeProvider')}</span>
          <div className="flex gap-4">
            {PROVIDER_NAMES.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="activeProvider"
                  checked={form.activeProvider === p}
                  onChange={() => setForm((f) => ({ ...f, activeProvider: p }))}
                />
                {t(`settings.provider.${p}`)}
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {PROVIDER_NAMES.map((provider) => (
            <div key={provider} className="rounded-md border border-gray-100 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">
                  {t(`settings.provider.${provider}`)}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    configured[provider]
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {configured[provider]
                    ? t('settings.keyConfigured')
                    : t('settings.keyNotConfigured')}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="text-xs text-gray-500">
                  {t('settings.baseUrl')}
                  <input
                    className={inputCls}
                    value={form.providers[provider].baseUrl}
                    onChange={(e) => setProviderField(provider, 'baseUrl', e.target.value)}
                  />
                </label>
                <label className="text-xs text-gray-500">
                  {t('settings.model')}
                  <input
                    className={inputCls}
                    placeholder={t('settings.modelPlaceholder')}
                    value={form.providers[provider].model}
                    onChange={(e) => setProviderField(provider, 'model', e.target.value)}
                  />
                </label>
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="flex-1 text-xs text-gray-500">
                  {t('settings.apiKey')}
                  <input
                    type="password"
                    className={inputCls}
                    placeholder={t('settings.keyPlaceholder')}
                    value={keyInputs[provider]}
                    onChange={(e) =>
                      setKeyInputs((prev) => ({ ...prev, [provider]: e.target.value }))
                    }
                  />
                </label>
                <button
                  className={btnCls}
                  disabled={!keyInputs[provider].trim() || saveKeyMutation.isPending}
                  onClick={() => saveKeyMutation.mutate(provider)}
                >
                  {configured[provider] ? t('settings.replaceKey') : t('settings.saveKey')}
                </button>
                <button
                  className={btnCls}
                  disabled={testKeyMutation.isPending}
                  onClick={() => testKeyMutation.mutate(provider)}
                >
                  {testKeyMutation.isPending ? t('settings.testing') : t('settings.testKey')}
                </button>
                <button
                  className={btnCls}
                  disabled={!configured[provider] || deleteKeyMutation.isPending}
                  onClick={() => deleteKeyMutation.mutate(provider)}
                >
                  {t('settings.deleteKey')}
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-gray-500">{t('settings.mockNote')}</p>
      </section>

      <div>
        <button
          className={primaryBtnCls}
          disabled={saveSettingsMutation.isPending}
          onClick={() => saveSettingsMutation.mutate()}
        >
          {saveSettingsMutation.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
