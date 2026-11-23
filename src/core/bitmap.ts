/**
 * The bit map: every bit of one high-order frame classified by what it is and, for payload
 * bits, traced back to the exact bit of the exact E1 that produced it.
 */
import { originOf, tagOf, type Origin, type Sym } from './bits';
import { kindName, type CellKind, type MuxSpec } from './mux';

export interface Cell {
  index: number;
  bit: number;
  kind: CellKind;
  /** Tributary of this level (0..3) for Cj, S and data cells. */
  trib: number;
  /** Which control bit for Cj cells, which FAS bit for FAS cells. */
  idx: number;
  /** E1 that produced the bit (payload cells only; stuffing and overhead have none). */
  origin: Origin | null;
  /** Position of the E1 in the tree: E3 group, E2 group and E1 inside it. */
  path: { e3: number; e2: number; e1: number } | null;
  /** Data bit that was actually justification (the S slot carrying data). */
  carriedInS: boolean;
  /** A data cell that no E1 produced: overhead (FAS, Cj, stuffing) of a lower multiplexing level. */
  lowerOverhead: boolean;
}

export function bitMap(spec: MuxSpec, frame: ArrayLike<Sym>): Cell[] {
  const cells: Cell[] = [];
  const { kind, trib, idx } = spec.layout;
  for (let i = 0; i < spec.frameBits; i++) {
    const s = frame[i]!;
    const o = originOf(tagOf(s));
    const k = kindName(kind[i]!);
    cells.push({
      index: i,
      bit: s % 2,
      kind: k === 'stuff' && o ? 'data' : k,
      trib: trib[i]!,
      idx: idx[i]!,
      origin: o,
      path: o ? { e3: o.src >> 4, e2: (o.src >> 2) & 3, e1: o.src & 3 } : null,
      carriedInS: k === 'stuff' && !!o,
      lowerOverhead: k === 'data' && !o,
    });
  }
  return cells;
}

/** Share of the frame taken by each kind of cell. */
export function composition(cells: Cell[]): Record<CellKind, number> {
  const c: Record<CellKind, number> = { fas: 0, alarm: 0, national: 0, reserved: 0, cj: 0, stuff: 0, data: 0 };
  for (const x of cells) c[x.kind]++;
  return c;
}

/** Where, in frames and bits, a given E1 bit lands inside a run of high-order frames. */
export function locateE1Bit(frames: ArrayLike<Sym>[], src: number, bitIndex: number): { frame: number; offset: number } | null {
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f]!;
    for (let i = 0; i < fr.length; i++) {
      const o = originOf(tagOf(fr[i]!));
      if (o && o.src === src && o.bitIndex === bitIndex) return { frame: f, offset: i };
    }
  }
  return null;
}

/**
 * Position inside each high-order frame of the first bit of a given E1 time slot, per frame.
 * The jump between frames is the visible consequence of justification: you cannot know in
 * advance where in the E4 an E1 is.
 */
export function slotTrack(frames: ArrayLike<Sym>[], src: number, ts: number): (number | null)[] {
  return frames.map((fr) => {
    for (let i = 0; i < fr.length; i++) {
      const o = originOf(tagOf(fr[i]!));
      if (o && o.src === src && o.ts === ts && o.bitInTs === 1) return i;
    }
    return null;
  });
}
