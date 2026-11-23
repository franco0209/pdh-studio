import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'es' | 'en';

export const LANGUAGES: { code: Lang; name: string }[] = [
  { code: 'es', name: 'Español' },
  { code: 'en', name: 'English' },
];

const isLang = (v: unknown): v is Lang => v === 'es' || v === 'en';

/** Order: ?lang= override, saved choice, browser languages, Spanish. */
export function detectLang(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (isLang(q)) return q;
  } catch {
    /* ignore */
  }
  try {
    const saved = localStorage.getItem('lang');
    if (isLang(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'es';
}

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Pick the text for the current language: tr('Hola', 'Hello'). Both live next to each use. */
  tr: (es: string, en: string) => string;
  /** Locale-aware number formatting. */
  num: (n: number, digits?: number) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = lang === 'es' ? 'PDH Studio · Emulador de la Jerarquía Digital Plesiócrona' : 'PDH Studio · Plesiochronous Digital Hierarchy emulator';
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('lang', l);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      tr: (es, en) => (lang === 'es' ? es : en),
      num: (n, digits = 2) =>
        Number.isFinite(n) ? n.toLocaleString(lang === 'es' ? 'es-PE' : 'en-US', { maximumFractionDigits: digits }) : '∞',
    }),
    [lang, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n must be used inside <I18nProvider>');
  return v;
}
