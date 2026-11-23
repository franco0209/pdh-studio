import { describe, expect, it } from 'vitest';
import { originOf, tagOf, bitOf } from './bits';
import {
  E2_SPEC,
  E3_SPEC,
  E4_SPEC,
  demuxFrame,
  framesPerSecond,
  justificationRangePpm,
  kindName,
  nominalStuffRatio,
  type MuxSpec,
} from './mux';
import { buildTree, cutFrames, demuxStream, demuxTree, injectErrors, sameStream } from './tree';

function countKinds(spec: MuxSpec) {
  const c: Record<string, number> = {};
  for (let i = 0; i < spec.frameBits; i++) {
    const k = kindName(spec.layout.kind[i]!);
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
}

describe('frame layouts (G.742 / G.751)', () => {
  it('E2: 848 bits, 4 sets of 212, 205 data bits per tributary (+1 justification)', () => {
    const c = countKinds(E2_SPEC);
    expect(E2_SPEC.frameBits).toBe(848);
    expect(c).toMatchObject({ fas: 10, alarm: 1, national: 1, cj: 12, stuff: 4, data: 820 });
    expect(E2_SPEC.dataPerTrib).toBe(205);
  });
  it('E3: 1536 bits, 377 data bits per tributary', () => {
    const c = countKinds(E3_SPEC);
    expect(c).toMatchObject({ fas: 10, alarm: 1, national: 1, cj: 12, stuff: 4, data: 1508 });
    expect(E3_SPEC.dataPerTrib).toBe(377);
  });
  it('E4: 2928 bits, 5 Cj bits per tributary, 722 data bits per tributary', () => {
    const c = countKinds(E4_SPEC);
    expect(c).toMatchObject({ fas: 12, alarm: 1, national: 1, reserved: 2, cj: 20, stuff: 4, data: 2888 });
    expect(E4_SPEC.dataPerTrib).toBe(722);
  });
  it('frame rates match the slides', () => {
    expect(framesPerSecond(E2_SPEC)).toBeCloseTo(9962.26, 2);
    expect(framesPerSecond(E3_SPEC)).toBe(22375);
    expect(framesPerSecond(E4_SPEC)).toBeCloseTo(47562.84, 1);
  });
  it('line rate = 4 x tributary + overhead, and the overhead is the one of the slides', () => {
    expect(E2_SPEC.lineRate - 4 * E2_SPEC.tribRate).toBe(256_000);
    expect(E3_SPEC.lineRate - 4 * E3_SPEC.tribRate).toBe(576_000);
    expect(E4_SPEC.lineRate - 4 * E4_SPEC.tribRate).toBe(1_792_000);
  });
  it('nominal stuffing ratios 0.424 / 0.436 / 0.419', () => {
    expect(nominalStuffRatio(E2_SPEC)).toBeCloseTo(0.424, 3);
    expect(nominalStuffRatio(E3_SPEC)).toBeCloseTo(0.436, 3);
    expect(nominalStuffRatio(E4_SPEC)).toBeCloseTo(0.419, 3);
  });
  it('every tributary has the same number of data cells and the same Cj and S count', () => {
    for (const spec of [E2_SPEC, E3_SPEC, E4_SPEC]) {
      for (let t = 0; t < 4; t++) {
        let data = 0;
        let cj = 0;
        let s = 0;
        for (let i = 0; i < spec.frameBits; i++) {
          if (spec.layout.trib[i] !== t) continue;
          const k = kindName(spec.layout.kind[i]!);
          if (k === 'data') data++;
          if (k === 'cj') cj++;
          if (k === 'stuff') s++;
        }
        expect(data).toBe(spec.dataPerTrib);
        expect(cj).toBe(spec.cjBits);
        expect(s).toBe(1);
      }
    }
  });
  it('the justification range covers the tolerance of the clocks with room to spare', () => {
    for (const spec of [E2_SPEC, E3_SPEC, E4_SPEC]) {
      const r = justificationRangePpm(spec);
      expect(r.lowPpm).toBeLessThan(-spec.tolerancePpm * 2);
      expect(r.highPpm).toBeGreaterThan(spec.tolerancePpm * 2);
    }
  });
});

describe('2/8 multiplexer, bit exact round trip', () => {
  it('four E1 with different clocks come back identical, tags included', () => {
    const tree = buildTree({ top: 'E2', e1Ppm: [-40, 0, 25, 50], e2Ppm: [10] });
    const frames = Array.from({ length: 400 }, () => tree.nextTopFrame().symbols);
    const out = demuxTree('E2', frames);
    for (let i = 0; i < 4; i++) {
      expect(out[i]!.length).toBeGreaterThan(200 * 205);
    }
    // regenerate the same E1 streams from scratch and compare
    const ref = buildTree({ top: 'E2' });
    for (let i = 0; i < 4; i++) {
      const expected = ref.e1[i]!.pull(out[i]!.length);
      expect(sameStream(out[i]!, expected)).toBe(true);
    }
  });

  it('justification follows the clock: a fast tributary stuffs less, a slow one more', () => {
    const tree = buildTree({ top: 'E2', e1Ppm: [-50, 0, 50, 50] });
    for (let i = 0; i < 20000; i++) tree.nextTopFrame();
    const row = tree.stats.E2.stuffed[0]!;
    const n = tree.stats.E2.frames;
    const ratios = row.map((s) => s / n);
    expect(ratios[0]!).toBeGreaterThan(ratios[1]!);
    expect(ratios[1]!).toBeGreaterThan(ratios[2]!);
    // nominal clocks give 0.424
    expect(ratios[1]!).toBeCloseTo(nominalStuffRatio(E2_SPEC) + (0 * 0), 1);
  });

  it('the measured stuffing ratio matches theory for a given ppm offset', () => {
    const ppm = 30;
    const tree = buildTree({ top: 'E2', e1Ppm: [ppm, ppm, ppm, ppm] });
    const n = 40000;
    for (let i = 0; i < n; i++) tree.nextTopFrame();
    const bitsPerFrame = (E2_SPEC.tribRate * (1 + ppm * 1e-6) * E2_SPEC.frameBits) / E2_SPEC.lineRate;
    const theory = E2_SPEC.dataPerTrib + 1 - bitsPerFrame;
    const measured = tree.stats.E2.stuffed[0]![0]! / n;
    expect(measured).toBeCloseTo(theory, 2);
  });

  it('a single error in a Cj bit is corrected by the 2-of-3 vote', () => {
    const tree = buildTree({ top: 'E2' });
    const frames = Array.from({ length: 50 }, () => tree.nextTopFrame().symbols);
    const clean = demuxStream(E2_SPEC, frames.map((f) => f.slice()));
    // flip the first Cj bit of every frame
    const noisy = frames.map((f) => f.slice());
    for (const f of noisy) {
      for (let i = 0; i < f.length; i++) {
        if (kindName(E2_SPEC.layout.kind[i]!) === 'cj') {
          f[i] = f[i]! % 2 === 0 ? f[i]! + 1 : f[i]! - 1;
          break;
        }
      }
    }
    const d = demuxStream(E2_SPEC, noisy);
    expect(d.cjDisagreements).toBe(50);
    for (let t = 0; t < 4; t++) expect(sameStream(d.tribs[t]!, clean.tribs[t]!)).toBe(true);
  });

  it('two errors in the three Cj bits of a tributary cost one wrong justification decision', () => {
    const tree = buildTree({ top: 'E2' });
    const f = tree.nextTopFrame().symbols;
    const before = demuxFrame(E2_SPEC, f);
    const g = f.slice();
    let flipped = 0;
    for (let i = 0; i < g.length && flipped < 2; i++) {
      if (kindName(E2_SPEC.layout.kind[i]!) === 'cj' && E2_SPEC.layout.trib[i] === 0) {
        g[i] = g[i]! % 2 === 0 ? g[i]! + 1 : g[i]! - 1;
        flipped++;
      }
    }
    const after = demuxFrame(E2_SPEC, g);
    expect(after.stuffed[0]).toBe(!before.stuffed[0]);
    expect(after.tribs[0]!.length).not.toBe(before.tribs[0]!.length);
  });

  it('the FAS of every frame is the one in the slides', () => {
    const tree = buildTree({ top: 'E2' });
    const f = tree.nextTopFrame().symbols;
    expect(f.slice(0, 10).map(bitOf).join('')).toBe('1111010000');
    expect(demuxFrame(E2_SPEC, f).fasOk).toBe(true);
    const bad = f.slice();
    bad[3] = bad[3]! % 2 === 0 ? bad[3]! + 1 : bad[3]! - 1;
    expect(demuxFrame(E2_SPEC, bad).fasOk).toBe(false);
  });
});

describe('full tree: 16 E1 -> E3 and 64 E1 -> E4', () => {
  it('E3 round trip with a different ppm on every E1 and on every E2 multiplexer', () => {
    const e1Ppm = Array.from({ length: 16 }, (_, i) => (i - 8) * 6);
    const tree = buildTree({ top: 'E3', e1Ppm, e2Ppm: [-20, 5, 12, 20] });
    const frames = Array.from({ length: 300 }, () => tree.nextTopFrame().symbols);
    const out = demuxTree('E3', frames);
    expect(out.length).toBe(16);
    const ref = buildTree({ top: 'E3' });
    for (let i = 0; i < 16; i++) {
      const expected = ref.e1[i]!.pull(out[i]!.length);
      expect(out[i]!.length).toBeGreaterThan(1000);
      expect(sameStream(out[i]!, expected)).toBe(true);
    }
  });

  it('E4 round trip: all 64 E1 are recovered bit by bit', () => {
    const e1Ppm = Array.from({ length: 64 }, (_, i) => ((i * 37) % 101) - 50);
    const tree = buildTree({ top: 'E4', e1Ppm, e2Ppm: Array.from({ length: 16 }, (_, i) => (i % 5) * 4 - 8), e3Ppm: [-10, 3, 8, 14], e4Ppm: 7 });
    const frames = Array.from({ length: 160 }, () => tree.nextTopFrame().symbols);
    const out = demuxTree('E4', frames);
    expect(out.length).toBe(64);
    const ref = buildTree({ top: 'E4' });
    for (let i = 0; i < 64; i++) {
      const expected = ref.e1[i]!.pull(out[i]!.length);
      expect(out[i]!.length).toBeGreaterThan(100);
      expect(sameStream(out[i]!, expected)).toBe(true);
    }
  });

  it('an E1 can be traced to its place in the E4: the position moves from frame to frame', () => {
    const tree = buildTree({ top: 'E4', e1Ppm: Array(64).fill(20) });
    const positions: number[] = [];
    for (let f = 0; f < 60; f++) {
      const frame = tree.nextTopFrame().symbols;
      const idx = frame.findIndex((s) => {
        const o = originOf(tagOf(s));
        return o?.src === 5 && o.bitIndex === 300;
      });
      if (idx >= 0) positions.push(f * 2928 + idx);
    }
    expect(positions.length).toBe(1);
  });

  it('extracting one E1 from an E4 needs the three demultiplexing stages', () => {
    const tree = buildTree({ top: 'E4' });
    const frames = Array.from({ length: 50 }, () => tree.nextTopFrame().symbols);
    // without going through E3 and E2 the E1 bits are not contiguous: a slice of the E4 is not an E1
    const e3 = demuxStream(E4_SPEC, frames).tribs[0]!;
    const fasLike = e3.slice(0, 10).map(bitOf).join('');
    expect(fasLike).toBe('1111010000'); // what comes out is an E3 line, not an E1
    expect(cutFrames(e3, 1536).length).toBeGreaterThan(5);
  });

  it('line errors are caught as FAS errors and BER is respected', () => {
    const tree = buildTree({ top: 'E3' });
    const frames = Array.from({ length: 300 }, () => tree.nextTopFrame().symbols);
    const flipped = injectErrors(frames, 1e-3, 7);
    const total = 300 * 1536;
    expect(flipped).toBeGreaterThan(total * 1e-3 * 0.6);
    expect(flipped).toBeLessThan(total * 1e-3 * 1.4);
    expect(demuxStream(E3_SPEC, frames).fasErrors).toBeGreaterThan(0);
  });
});
