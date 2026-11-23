/**
 * Line codes of ITU-T G.703: AMI, HDB3 (E1, E2, E3) and B8ZS (T1).
 * A pulse train is an array of -1, 0 and +1 (negative pulse, no pulse, positive pulse).
 */

export type Pulse = -1 | 0 | 1;

export function amiEncode(bits: ArrayLike<number>): Pulse[] {
  let last: Pulse = -1;
  const out: Pulse[] = [];
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      last = (last === 1 ? -1 : 1) as Pulse;
      out.push(last);
    } else out.push(0);
  }
  return out;
}

export function amiDecode(pulses: ArrayLike<number>): number[] {
  return Array.from(pulses, (p) => (p === 0 ? 0 : 1));
}

export interface Hdb3Marks {
  /** Index of every pulse that is a substituted violation (V) or a filler (B). */
  violations: number[];
  fillers: number[];
}

/**
 * HDB3: never more than 3 zeros in a row. Four zeros become 000V or B00V, where V repeats the
 * polarity of the previous pulse (a deliberate violation) and B respects the alternation.
 * The choice keeps an odd number of ordinary pulses between two V so the DC stays balanced.
 */
export function hdb3Encode(bits: ArrayLike<number>, marks?: Hdb3Marks): Pulse[] {
  const out: Pulse[] = [];
  let last: Pulse = -1;
  let sinceSub = 0;
  let i = 0;
  while (i < bits.length) {
    if (bits[i]) {
      last = (last === 1 ? -1 : 1) as Pulse;
      out.push(last);
      sinceSub++;
      i++;
    } else if (i + 3 < bits.length && !bits[i + 1] && !bits[i + 2] && !bits[i + 3]) {
      if (sinceSub % 2 === 1) {
        out.push(0, 0, 0, last);
        marks?.violations.push(out.length - 1);
      } else {
        const b = (last === 1 ? -1 : 1) as Pulse;
        out.push(b, 0, 0, b);
        marks?.fillers.push(out.length - 4);
        marks?.violations.push(out.length - 1);
        last = b;
      }
      sinceSub = 0;
      i += 4;
    } else {
      out.push(0);
      i++;
    }
  }
  return out;
}

export function hdb3Decode(pulses: ArrayLike<number>): number[] {
  const out = Array.from(pulses, (p) => (p === 0 ? 0 : 1));
  let last = 0;
  for (let i = 0; i < pulses.length; i++) {
    const p = pulses[i]!;
    if (p === 0) continue;
    if (p === last) {
      // violation: it and the three positions before it were a substituted group of four zeros
      for (let k = Math.max(0, i - 3); k <= i; k++) out[k] = 0;
    }
    last = p;
  }
  return out;
}

/** B8ZS: eight zeros become 000VB0VB, with V following the last pulse's polarity. */
export function b8zsEncode(bits: ArrayLike<number>): Pulse[] {
  const out: Pulse[] = [];
  let last: Pulse = -1;
  let i = 0;
  const flip = (p: Pulse): Pulse => (p === 1 ? -1 : 1);
  while (i < bits.length) {
    if (bits[i]) {
      last = flip(last);
      out.push(last);
      i++;
    } else if (i + 7 < bits.length && [1, 2, 3, 4, 5, 6, 7].every((k) => !bits[i + k])) {
      const v: Pulse = last;
      out.push(0, 0, 0, v, flip(v), 0, flip(v), v);
      last = v;
      i += 8;
    } else {
      out.push(0);
      i++;
    }
  }
  return out;
}

export function b8zsDecode(pulses: ArrayLike<number>): number[] {
  const out = Array.from(pulses, (p) => (p === 0 ? 0 : 1));
  let last = 0;
  let i = 0;
  while (i < pulses.length) {
    const p = pulses[i]!;
    if (
      i + 7 < pulses.length &&
      p === 0 &&
      pulses[i + 1] === 0 &&
      pulses[i + 2] === 0 &&
      pulses[i + 3] !== 0 &&
      pulses[i + 3] === last &&
      pulses[i + 4] === -pulses[i + 3]! &&
      pulses[i + 5] === 0 &&
      pulses[i + 6] === pulses[i + 4] &&
      pulses[i + 7] === -pulses[i + 6]!
    ) {
      for (let k = 0; k < 8; k++) out[i + k] = 0;
      last = pulses[i + 7]!;
      i += 8;
      continue;
    }
    if (p !== 0) last = p;
    i++;
  }
  return out;
}

/** Longest run of zeros on the line: the number that decides whether the receiver keeps its clock. */
export function longestZeroRun(pulses: ArrayLike<number>): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < pulses.length; i++) {
    if (pulses[i] === 0) best = Math.max(best, ++run);
    else run = 0;
  }
  return best;
}

/** Sum of pulses: stays bounded for a balanced code (no DC component). */
export function runningDisparity(pulses: ArrayLike<number>): { min: number; max: number; end: number } {
  let s = 0;
  let min = 0;
  let max = 0;
  for (let i = 0; i < pulses.length; i++) {
    s += pulses[i]!;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min, max, end: s };
}
