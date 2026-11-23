import { describe, expect, it } from 'vitest';
import { DEFAULT_LAB } from '../components/Lab';
import { decodeState, DEFAULT_NET, encodeState, type AppState } from './urlState';

const base: AppState = { tab: 'lab', lab: DEFAULT_LAB, net: DEFAULT_NET };

describe('URL state', () => {
  it('the default scenario only writes the tab', () => {
    expect(encodeState(base)).toBe('tab=lab');
  });

  it('round-trips a custom scenario', () => {
    const s: AppState = {
      tab: 'network',
      lab: { ...DEFAULT_LAB, top: 'E3', preset: 'extremes', selE1: 9, selPpm: -33, e2Ppm: 12, e3Ppm: -4, berExp: 5, content: 'prbs', crc4: false },
      net: { selected: 'T2', strategy: 'naive', fault: { trunk: 'T1', link: 1, mode: 'forward' } },
    };
    expect(decodeState(`#${encodeState(s)}`)).toEqual(s);
  });

  it('clamps and ignores nonsense', () => {
    const s = decodeState('#tab=zzz&top=E9&e1=999&p2=500&ber=-4&nf=T1.99.cut&nt=nope&ppm=abc');
    expect(s.tab).toBe('lab');
    expect(s.lab.top).toBe('E4');
    expect(s.lab.selE1).toBe(63);
    expect(s.lab.e2Ppm).toBe(30);
    expect(s.lab.berExp).toBe(0);
    expect(s.net.fault).toBeNull();
    expect(s.net.selected).toBe('T1');
  });

  it('keeps the observed E1 inside the chosen level', () => {
    expect(decodeState('#top=E2&e1=40').lab.selE1).toBe(3);
  });
});
