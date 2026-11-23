import { DEFAULT_LAB, type LabParams } from '../components/Lab';
import { SOUTH_PERU, type Fault, type FaultMode, type Strategy } from '../core/network';

export type Tab = 'lab' | 'e1' | 'pcm' | 'clock' | 'quality' | 'network';
export const TABS: Tab[] = ['lab', 'e1', 'pcm', 'clock', 'quality', 'network'];

export interface NetView {
  selected: string;
  strategy: Strategy;
  fault: Fault | null;
}

export const DEFAULT_NET: NetView = { selected: 'T1', strategy: 'optimised', fault: null };

export interface AppState {
  tab: Tab;
  lab: LabParams;
  net: NetView;
}

const isTab = (v: string | null): v is Tab => !!v && (TABS as string[]).includes(v);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The whole scenario lives in the URL hash so it can be shared: only values that differ from the default are written. */
export function encodeState(s: AppState): string {
  const p = new URLSearchParams();
  p.set('tab', s.tab);
  const d = DEFAULT_LAB;
  const l = s.lab;
  if (l.top !== d.top) p.set('top', l.top);
  if (l.preset !== d.preset) p.set('clk', l.preset);
  if (l.selE1 !== d.selE1) p.set('e1', String(l.selE1));
  if (l.selPpm !== null) p.set('ppm', String(l.selPpm));
  if (l.e2Ppm !== d.e2Ppm) p.set('p2', String(l.e2Ppm));
  if (l.e3Ppm !== d.e3Ppm) p.set('p3', String(l.e3Ppm));
  if (l.e4Ppm !== d.e4Ppm) p.set('p4', String(l.e4Ppm));
  if (l.berExp !== d.berExp) p.set('ber', String(l.berExp));
  if (l.content !== d.content) p.set('c', l.content);
  if (l.crc4 !== d.crc4) p.set('crc', l.crc4 ? '1' : '0');
  const n = s.net;
  if (n.selected !== DEFAULT_NET.selected) p.set('nt', n.selected);
  if (n.strategy !== DEFAULT_NET.strategy) p.set('ns', n.strategy);
  if (n.fault) p.set('nf', `${n.fault.trunk}.${n.fault.link}.${n.fault.mode}`);
  return p.toString();
}

export function decodeState(hash: string): AppState {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const d = DEFAULT_LAB;
  const num = (k: string, lo: number, hi: number, def: number) => {
    const v = p.get(k);
    if (v === null || v === '' || Number.isNaN(Number(v))) return def;
    return clamp(Math.round(Number(v)), lo, hi);
  };
  const top = p.get('top');
  const topV = top === 'E2' || top === 'E3' || top === 'E4' ? top : d.top;
  const max = topV === 'E2' ? 3 : topV === 'E3' ? 15 : 63;
  const clk = p.get('clk');
  const c = p.get('c');
  const tab = p.get('tab');
  const nt = p.get('nt');
  const selected = SOUTH_PERU.trunks.some((t) => t.id === nt) ? (nt as string) : DEFAULT_NET.selected;
  let fault: Fault | null = null;
  const nf = p.get('nf')?.split('.');
  if (nf && nf.length === 3) {
    const trunk = SOUTH_PERU.trunks.find((t) => t.id === nf[0]);
    const link = Number(nf[1]);
    const mode = nf[2] as FaultMode;
    if (trunk && Number.isInteger(link) && link >= 0 && link < trunk.path.length - 1 && (mode === 'cut' || mode === 'forward' || mode === 'backward')) {
      fault = { trunk: trunk.id, link, mode };
    }
  }
  return {
    net: { selected, strategy: p.get('ns') === 'naive' ? 'naive' : 'optimised', fault },
    tab: isTab(tab) ? tab : 'lab',
    lab: {
      top: topV,
      preset: clk === 'nominal' || clk === 'spread' || clk === 'extremes' ? clk : d.preset,
      selE1: num('e1', 0, max, Math.min(d.selE1, max)),
      selPpm: p.has('ppm') ? num('ppm', -50, 50, 0) : null,
      e2Ppm: num('p2', -30, 30, d.e2Ppm),
      e3Ppm: num('p3', -20, 20, d.e3Ppm),
      e4Ppm: num('p4', -15, 15, d.e4Ppm),
      berExp: num('ber', 0, 6, d.berExp),
      content: c === 'tone' || c === 'prbs' || c === 'idle' ? c : d.content,
      crc4: p.get('crc') === '0' ? false : d.crc4,
    },
  };
}
