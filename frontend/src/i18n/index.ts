import { create } from 'zustand'
import type { Language } from '../types'
import { messages } from './messages'

const STORAGE_KEY = 'planner.lang'

function initialLang(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en-US' ? 'en-US' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

interface LangState {
  lang: Language
  setLang: (lang: Language) => void
}

/** Global UI language. Defaults to zh-CN; server settings are the source of
 *  truth and are synced into this store on load (see App.tsx). */
export const useLang = create<LangState>((set) => ({
  lang: initialLang(),
  setLang: (lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, lang)
    } catch {
      // ignore storage failures (private mode etc.)
    }
    set({ lang })
  },
}))

type Vars = Record<string, string | number>

export function translate(lang: Language, key: string, vars?: Vars): string {
  const table = messages[lang] ?? messages['zh-CN']
  let text = table[key] ?? messages['zh-CN'][key] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** Hook form: re-renders the component when the language changes. */
export function useT(): (key: string, vars?: Vars) => string {
  const lang = useLang((s) => s.lang)
  return (key, vars) => translate(lang, key, vars)
}

/** Non-reactive accessors for modules outside React (labels, api helpers). */
export function getLang(): Language {
  return useLang.getState().lang
}

export function t(key: string, vars?: Vars): string {
  return translate(getLang(), key, vars)
}
