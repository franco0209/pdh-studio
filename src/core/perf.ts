/**
 * Error performance of a 2 048 kbit/s path in the style of ITU-T G.826, and the bridge from
 * a radio hop (fade margin, distance, frequency) to bit errors and errored seconds.
 *
 * A block is a CRC-4 submultiframe: 2 048 bits, 1 000 blocks per second.
 *   ES   errored second: at least one errored block (or a defect)
 *   SES  severely errored second: at least 30 % of its blocks errored (or a defect)
 *   BBE  background block error: an errored block that is not part of an SES
 */
import { rng } from './bits';

export const BLOCK_BITS = 2048;
export const BLOCKS_PER_SECOND = 1000;
export const SES_BLOCK_FRACTION = 0.3;

/** End-to-end objectives for paths at 2 Mbit/s (G.826 table 1, 1.5 to 5 Mbit/s class). */
export const E1_OBJECTIVES = { esr: 0.04, sesr: 0.002, bber: 2e-4 };

export function blockErrorProbability(ber: number, blockBits = BLOCK_BITS): number {
  if (ber <= 0) return 0;
  if (ber >= 1) return 1;
  return -Math.expm1(blockBits * Math.log1p(-ber));
}

export interface Performance {
  seconds: number;
  es: number;
  ses: number;
  bbe: number;
  uas: number;
  esr: number;
  sesr: number;
  bber: number;
  /** Which objectives are met. */
  meets: { esr: boolean; sesr: boolean; bber: boolean; available: boolean; all: boolean };
}

function summarise(seconds: number, es: number, ses: number, bbe: number, uas: number, availableBlocks: number): Performance {
  const avail = Math.max(1, seconds - uas);
  const esr = es / avail;
  const sesr = ses / avail;
  const bber = availableBlocks > 0 ? bbe / availableBlocks : 0;
  const meets = {
    esr: esr <= E1_OBJECTIVES.esr,
    sesr: sesr <= E1_OBJECTIVES.sesr,
    bber: bber <= E1_OBJECTIVES.bber,
    // the ratios only count available time, so a path that was down cannot pass on them alone
    available: uas === 0,
    all: false,
  };
  meets.all = meets.esr && meets.sesr && meets.bber && meets.available;
  return { seconds, es, ses, bbe, uas, esr, sesr, bber, meets };
}

/**
 * Count ES / SES / BBE from the number of errored blocks in every second.
 * Unavailable time starts with 10 consecutive SES and ends at the first of 10 consecutive
 * non-SES (G.826); it is excluded from the counts.
 */
export function performanceFromBlocks(erroredPerSecond: number[]): Performance {
  const n = erroredPerSecond.length;
  const ses = erroredPerSecond.map((e) => e >= SES_BLOCK_FRACTION * BLOCKS_PER_SECOND);
  const unavailable = new Array<boolean>(n).fill(false);
  let i = 0;
  let down = false;
  while (i < n) {
    let j = i;
    if (!down) {
      if (ses[i]) {
        while (j < n && ses[j]) j++;
        if (j - i >= 10) {
          down = true;
          for (let k = i; k < j; k++) unavailable[k] = true;
        }
        i = j;
      } else i++;
    } else if (!ses[i]) {
      while (j < n && !ses[j]) j++;
      if (j - i >= 10) down = false;
      else for (let k = i; k < j; k++) unavailable[k] = true;
      i = j;
    } else {
      unavailable[i] = true;
      i++;
    }
  }
  let es = 0;
  let sesCount = 0;
  let bbe = 0;
  let uas = 0;
  let availBlocks = 0;
  for (let k = 0; k < n; k++) {
    if (unavailable[k]) {
      uas++;
      continue;
    }
    const e = erroredPerSecond[k]!;
    if (e > 0) es++;
    if (ses[k]) sesCount++;
    else bbe += e;
    availBlocks += BLOCKS_PER_SECOND;
  }
  return summarise(n, es, sesCount, bbe, uas, availBlocks);
}

/** Monte-Carlo run at a constant bit error ratio. Deterministic for a given seed. */
export function simulatePerformance(ber: number, seconds: number, seed = 1): Performance {
  const p = blockErrorProbability(ber);
  const rand = rng(seed);
  const perSecond: number[] = [];
  for (let s = 0; s < seconds; s++) {
    if (p <= 0) {
      perSecond.push(0);
      continue;
    }
    // errored blocks in a second ~ Binomial(1000, p): inverse by summation of Bernoulli draws
    let e = 0;
    if (p > 0.05) {
      for (let b = 0; b < BLOCKS_PER_SECOND; b++) if (rand() < p) e++;
    } else {
      // geometric skipping
      let i = Math.floor(Math.log(1 - rand()) / Math.log(1 - p));
      while (i < BLOCKS_PER_SECOND) {
        e++;
        i += 1 + Math.floor(Math.log(1 - rand()) / Math.log(1 - p));
      }
    }
    perSecond.push(e);
  }
  return performanceFromBlocks(perSecond);
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

const LF = Array.from({ length: BLOCKS_PER_SECOND + 1 }, (_, n) => logFactorial(n));

/** Closed form of the same quantities for a constant BER (binomial over the 1 000 blocks of a second). */
export function analyticPerformance(ber: number): { esr: number; sesr: number; bber: number } {
  const p = blockErrorProbability(ber);
  if (p <= 0) return { esr: 0, sesr: 0, bber: 0 };
  const n = BLOCKS_PER_SECOND;
  const k0 = Math.ceil(SES_BLOCK_FRACTION * n);
  let sesr = 0;
  let bbeBlocks = 0;
  for (let k = 0; k <= n; k++) {
    const lp = LF[n]! - LF[k]! - LF[n - k]! + k * Math.log(p) + (n - k) * Math.log1p(-Math.min(p, 1 - 1e-15));
    const pk = Math.exp(lp);
    if (k >= k0) sesr += pk;
    else bbeBlocks += k * pk;
  }
  return { esr: 1 - Math.pow(1 - p, n), sesr, bber: bbeBlocks / n };
}

/** Q function (tail of the standard normal). */
export function qfunc(x: number): number {
  // Abramowitz-Stegun 7.1.26 on erfc
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = y * Math.exp(-z * z);
  return x >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/** QPSK/coherent BPSK bit error ratio for a given Eb/N0 in dB. */
export const berQpsk = (ebn0Db: number): number => qfunc(Math.sqrt(2 * 10 ** (ebn0Db / 10)));

/** Eb/N0 (dB) that gives the BER the receiver sensitivity is quoted at. */
export function ebn0ForBer(targetBer: number): number {
  let lo = 0;
  let hi = 30;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (berQpsk(mid) > targetBer) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface HopInput {
  distKm: number;
  freqMHz: number;
  /** Fade margin over the threshold quoted at `thresholdBer`, dB (same one the link planner reports). */
  fadeMarginDb: number;
  terrainFactor?: number;
  /** BER at which the receiver sensitivity is specified. */
  thresholdBer?: number;
}

export interface HopQos {
  /** Probability of being in outage (multipath fade deeper than the margin): Vigants-Barnett. */
  outage: number;
  /** BER when the link is up and not fading (at the nominal received level). */
  berNominal: number;
  /** Same figure as an availability percentage. */
  availabilityPct: number;
  /** SES ratio contributed by the hop: every outage second is severely errored. */
  sesr: number;
  /** Errored-seconds ratio in clear weather, from the nominal BER. */
  esrClear: number;
}

/** Outage probability of one hop, same model as radio-link-planner (Vigants-Barnett). */
export function vigantsOutage(distKm: number, freqMHz: number, fadeMarginDb: number, terrainFactor = 1): number {
  if (fadeMarginDb <= 0) return 1;
  const u = 6.0e-7 * terrainFactor * (freqMHz / 1000) * distKm ** 3 * 10 ** (-fadeMarginDb / 10);
  return Math.min(1, u);
}

export function hopQos(h: HopInput): HopQos {
  const thr = h.thresholdBer ?? 1e-6;
  const outage = vigantsOutage(h.distKm, h.freqMHz, h.fadeMarginDb, h.terrainFactor ?? 1);
  const ebn0 = ebn0ForBer(thr) + h.fadeMarginDb;
  const berNominal = berQpsk(ebn0);
  return {
    outage,
    berNominal,
    availabilityPct: (1 - outage) * 100,
    sesr: outage,
    esrClear: analyticPerformance(berNominal).esr,
  };
}

/** Combine hops in series: outages add, error ratios add (they are small). */
export function seriesQos(hops: HopQos[]): { sesr: number; esr: number; availabilityPct: number } {
  const sesr = hops.reduce((a, h) => a + h.sesr, 0);
  const esr = hops.reduce((a, h) => a + h.esrClear, 0) + sesr;
  return { sesr, esr, availabilityPct: (1 - sesr) * 100 };
}
