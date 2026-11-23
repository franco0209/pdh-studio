import { useEffect, useState } from 'react';
import { ClockPanel } from './components/ClockPanel';
import { E1Inspector } from './components/E1Inspector';
import { Lab, type LabParams } from './components/Lab';
import { NetworkPanel } from './components/NetworkPanel';
import { PcmPanel } from './components/PcmPanel';
import { QualityPanel } from './components/QualityPanel';
import { LANGUAGES, useI18n, type Lang } from './i18n';
import { decodeState, encodeState, TABS, type Tab } from './state/urlState';

function readTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const { lang, setLang, tr } = useI18n();
  const [state, setState] = useState(() => decodeState(window.location.hash));
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  useEffect(() => {
    const h = encodeState(state);
    if (`#${h}` !== window.location.hash) window.history.replaceState(null, '', `#${h}`);
  }, [state]);

  useEffect(() => {
    const onHash = () => setState(decodeState(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const names: Record<Tab, string> = {
    lab: tr('Laboratorio', 'Lab'),
    e1: tr('Trama E1', 'E1 frame'),
    pcm: 'PCM',
    clock: tr('Relojes', 'Clocks'),
    quality: tr('Calidad', 'Quality'),
    network: tr('Red', 'Network'),
  };

  const share = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt(tr('Copia este enlace', 'Copy this link'), url);
    }
  };

  const setLab = (lab: LabParams) => setState({ ...state, lab });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="currentColor" />
            <g fill="#fff">
              {[7, 14, 21].flatMap((y, r) =>
                [5, 11, 17, 23].map((x, c) => <rect key={`${x}${y}`} x={x} y={y} width="4" height="4" rx="1" opacity={(r + c) % 3 === 0 ? 0.5 : 1} />),
              )}
            </g>
          </svg>
          <div>
            <h1>PDH Studio</h1>
            <span className="tagline">{tr('Jerarquía Digital Plesiócrona, bit a bit', 'Plesiochronous Digital Hierarchy, bit by bit')}</span>
          </div>
        </div>
        <nav className="tabs" aria-label={tr('Secciones', 'Sections')}>
          {TABS.map((t) => (
            <button key={t} type="button" className="tab" aria-current={state.tab === t ? 'page' : undefined} onClick={() => setState({ ...state, tab: t })}>
              {names[t]}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <select className="lang-select" value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={tr('Idioma', 'Language')}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-small" onClick={share}>
            🔗 <span className="lbl">{copied ? tr('¡Copiado!', 'Copied!') : tr('Compartir', 'Share')}</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? tr('Cambiar a tema claro', 'Switch to light theme') : tr('Cambiar a tema oscuro', 'Switch to dark theme')}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <div className="content">
        {state.tab === 'lab' && <Lab params={state.lab} setParams={setLab} dark={theme === 'dark'} />}
        {state.tab === 'e1' && (
          <div className="page">
            <E1Inspector />
          </div>
        )}
        {state.tab === 'pcm' && (
          <div className="page">
            <PcmPanel />
          </div>
        )}
        {state.tab === 'clock' && (
          <div className="page">
            <ClockPanel />
          </div>
        )}
        {state.tab === 'quality' && (
          <div className="page">
            <QualityPanel />
          </div>
        )}
        {state.tab === 'network' && <NetworkPanel dark={theme === 'dark'} view={state.net} setView={(net) => setState({ ...state, net })} />}
      </div>
    </div>
  );
}
