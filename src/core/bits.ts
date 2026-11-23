/**
 * Bit helpers and the "symbol" convention used by the multiplexers.
 *
 * A symbol is a plain number: its lowest bit is the bit value and the rest is an
 * origin tag. Tag 0 means "overhead generated at this level" and any other tag
 * identifies the exact bit of the exact E1 it came from, so a bit seen on an E4
 * line can be traced back to its E1, time slot and sample.
 */
export type Sym = number;

export const bitOf = (s: Sym): number => s % 2;
export const tagOf = (s: Sym): number => Math.floor(s / 2);
export const makeSym = (bit: number, tag = 0): Sym => tag * 2 + bit;
export const flipSym = (s: Sym): Sym => (s % 2 === 0 ? s + 1 : s - 1);

/** Where a tagged bit was born: E1 number (0..63), absolute bit index in that E1. */
const SRC_STRIDE = 2 ** 26;
export const MAX_E1_BITS = SRC_STRIDE - 1;

export function makeTag(src: number, bitIndex: number): number {
  return 1 + bitIndex + src * SRC_STRIDE;
}

export interface Origin {
  /** E1 number 0..63 inside an E4 (E3 = src >> 4, E2 = (src >> 2) & 3, E1 = src & 3). */
  src: number;
  bitIndex: number;
  /** E1 frame number, time slot 0..31 and bit 1..8 inside the slot (as numbered in G.704). */
  frame: number;
  ts: number;
  bitInTs: number;
}

export function originOf(tag: number): Origin | null {
  if (tag <= 0) return null;
  const t = tag - 1;
  const src = Math.floor(t / SRC_STRIDE);
  const bitIndex = t - src * SRC_STRIDE;
  const inFrame = bitIndex % 256;
  return { src, bitIndex, frame: Math.floor(bitIndex / 256), ts: Math.floor(inFrame / 8), bitInTs: (inFrame % 8) + 1 };
}

/** Bytes to bits, most significant bit first (the order bits go on the wire). */
export function bytesToBits(bytes: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) for (let b = 7; b >= 0; b--) out.push((bytes[i]! >> b) & 1);
  return out;
}

export function bitsToByte(bits: ArrayLike<number>, start = 0): number {
  let v = 0;
  for (let i = 0; i < 8; i++) v = (v << 1) | (bits[start + i]! & 1);
  return v;
}

export function bitString(bits: ArrayLike<number>, from = 0, to = bits.length): string {
  let s = '';
  for (let i = from; i < to; i++) s += bits[i]! & 1;
  return s;
}

/** Small deterministic PRNG (mulberry32) so every run and every test is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ITU-T O.150 pseudo-random binary sequences (Fibonacci LFSR). */
const PRBS_TAPS: Record<number, [number, number]> = {
  9: [9, 5],
  11: [11, 9],
  15: [15, 14],
  23: [23, 18],
};

export type PrbsOrder = 9 | 11 | 15 | 23;

export class Prbs {
  private state: number;
  private readonly n: number;
  private readonly tap: number;
  constructor(order: PrbsOrder = 15, seed = 1) {
    const [n, tap] = PRBS_TAPS[order]!;
    this.n = n;
    this.tap = tap;
    this.state = seed & ((1 << n) - 1) || 1;
  }
  next(): number {
    const out = (this.state >> (this.n - 1)) & 1;
    const fb = out ^ ((this.state >> (this.tap - 1)) & 1);
    this.state = ((this.state << 1) | fb) & ((1 << this.n) - 1);
    return out;
  }
}
