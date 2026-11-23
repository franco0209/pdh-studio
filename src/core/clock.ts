/**
 * Plesiochronous clocks, elastic buffers and slips (ITU-T G.703, G.811, G.822, G.823).
 *
 * Two ends of an E1 each run on their own clock, +-50 ppm at worst. The receiving buffer
 * slowly fills or empties and, when it cannot take more, one whole 125 us frame is lost or
 * repeated: a controlled slip.
 */
import { E1_FRAME_BITS, E1_RATE } from './e1';

/** Frequency difference, bit/s, between two clocks at `rate` with the given errors. */
export function offsetBps(rate: number, ppmA: number, ppmB: number): number {
  return rate * Math.abs(ppmA - ppmB) * 1e-6;
}

/** Seconds between two controlled slips of a frame buffer: one frame of drift. */
export function slipIntervalSeconds(ppmA: number, ppmB: number, rate = E1_RATE, frameBits = E1_FRAME_BITS): number {
  const d = offsetBps(rate, ppmA, ppmB);
  return d === 0 ? Infinity : frameBits / d;
}

export interface BufferSample {
  t: number;
  /** Buffer fill relative to its centre, in bits. */
  level: number;
}

export interface BufferRun {
  samples: BufferSample[];
  slips: { t: number; direction: 'repeat' | 'delete' }[];
  /** Half of the window the buffer tolerates before it must slip, bits. */
  halfWindow: number;
}

/**
 * Integrate the drift of a frame buffer. Positive offset (write clock faster than the read
 * clock) fills it and the buffer deletes a frame; negative empties it and a frame is repeated.
 * `startLevel` lets the run start anywhere inside the window, as a real link does.
 */
export function simulateElasticBuffer(opts: {
  ppmWrite: number;
  ppmRead: number;
  seconds: number;
  rate?: number;
  frameBits?: number;
  startLevel?: number;
  steps?: number;
}): BufferRun {
  const rate = opts.rate ?? E1_RATE;
  const frame = opts.frameBits ?? E1_FRAME_BITS;
  const half = frame / 2;
  const dBps = rate * (opts.ppmWrite - opts.ppmRead) * 1e-6;
  const steps = opts.steps ?? 600;
  const dt = opts.seconds / steps;
  let level = opts.startLevel ?? 0;
  const samples: BufferSample[] = [];
  const slips: BufferRun['slips'] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    samples.push({ t, level });
    level += dBps * dt;
    while (level > half) {
      level -= frame;
      slips.push({ t: t + dt, direction: 'delete' });
    }
    while (level < -half) {
      level += frame;
      slips.push({ t: t + dt, direction: 'repeat' });
    }
  }
  return { samples, slips, halfWindow: half };
}

/** Maximum clock difference ITU-T G.703 allows between two free-running E1 equipment, ppm. */
export const E1_TOLERANCE_PPM = 50;

/**
 * Time interval error produced by a frequency offset after `t` seconds, in unit intervals (UI)
 * of the E1 (488 ns). Wander is exactly this growth when the offset is constant.
 */
export function tieUi(ppmDiff: number, t: number, rate = E1_RATE): number {
  return ppmDiff * 1e-6 * rate * t;
}

/** Jitter and wander split at 10 Hz (ITU-T G.810): faster phase variation is jitter. */
export const JITTER_WANDER_BOUNDARY_HZ = 10;

/**
 * Peak-to-peak phase excursion, in bits (unit intervals of the tributary), of the stream a
 * tributary receives after the multiplexer: the cumulative bits delivered per frame minus the
 * straight line (least squares) that an ideal, jitter-free delivery would follow.
 */
export function measureWaitingJitterUi(deliveredPerFrame: number[]): number {
  const n = deliveredPerFrame.length;
  if (n < 2) return 0;
  const cum: number[] = [];
  let c = 0;
  for (const d of deliveredPerFrame) cum.push((c += d));
  const xm = (n + 1) / 2;
  const ym = cum.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i + 1 - xm) * (cum[i]! - ym);
    sxx += (i + 1 - xm) ** 2;
  }
  const slope = sxy / sxx;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const err = cum[i]! - (ym + slope * (i + 1 - xm));
    if (err < min) min = err;
    if (err > max) max = err;
  }
  return max - min;
}
