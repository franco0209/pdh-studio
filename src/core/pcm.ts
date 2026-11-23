/**
 * Pulse code modulation of the voice channel, ITU-T G.711.
 * 8 000 samples/s x 8 bits = 64 kbit/s (the DS0 every PDH level is built from).
 * Linear samples are 16-bit signed integers.
 */

export const SAMPLE_RATE = 8000;
export const A_LAW = 87.6;
export const MU_LAW = 255;

const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];

function segment(v: number, table: number[]): number {
  for (let i = 0; i < table.length; i++) if (v <= table[i]!) return i;
  return table.length;
}

/** A-law (Europe, E1): 16-bit linear sample to the 8-bit code, even bits inverted as G.711 requires. */
export function linearToAlaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample))) >> 3;
  let mask: number;
  if (pcm >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  const seg = segment(pcm, SEG_AEND);
  if (seg >= 8) return 0x7f ^ mask;
  let aval = seg << 4;
  aval |= seg < 2 ? (pcm >> 1) & 0xf : (pcm >> seg) & 0xf;
  return aval ^ mask;
}

export function alawToLinear(code: number): number {
  const a = (code & 0xff) ^ 0x55;
  let t = (a & 0xf) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else {
    t += 0x108;
    if (seg > 1) t <<= seg - 1;
  }
  return a & 0x80 ? t : -t;
}

const BIAS = 0x84;
const CLIP = 8159;

/** Mu-law (USA, Japan, T1). */
export function linearToUlaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample))) >> 2;
  let mask: number;
  if (pcm < 0) {
    pcm = -pcm;
    mask = 0x7f;
  } else mask = 0xff;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS >> 2;
  const seg = segment(pcm, SEG_UEND);
  if (seg >= 8) return 0x7f ^ mask;
  const u = (seg << 4) | ((pcm >> (seg + 1)) & 0xf);
  return u ^ mask;
}

export function ulawToLinear(code: number): number {
  const u = ~code & 0xff;
  let t = ((u & 0xf) << 3) + BIAS;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? BIAS - t : t - BIAS;
}

/** Continuous compression curves of the slides (x normalised to |x| <= 1). */
export function compressA(x: number, a = A_LAW): number {
  const ax = Math.abs(x);
  const y = ax < 1 / a ? (a * ax) / (1 + Math.log(a)) : (1 + Math.log(a * ax)) / (1 + Math.log(a));
  return Math.sign(x) * y;
}

export function compressMu(x: number, mu = MU_LAW): number {
  return (Math.sign(x) * Math.log(1 + mu * Math.abs(x))) / Math.log(1 + mu);
}

/** Theoretical SNR of a uniform n-bit quantiser with a full-scale sine: 6.02 n + 1.76 dB. */
export const uniformSnrDb = (bits: number): number => 6.02 * bits + 1.76;

export interface PcmResult {
  codes: number[];
  decoded: number[];
  snrDb: number;
}

/** Encode a sine through the chosen law and measure the real SNR of the round trip. */
export function pcmSineTest(amplitude: number, freqHz: number, law: 'A' | 'mu' = 'A', samples = 800): PcmResult {
  const enc = law === 'A' ? linearToAlaw : linearToUlaw;
  const dec = law === 'A' ? alawToLinear : ulawToLinear;
  const codes: number[] = [];
  const decoded: number[] = [];
  let sig = 0;
  let noise = 0;
  for (let n = 0; n < samples; n++) {
    const x = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * n) / SAMPLE_RATE));
    const c = enc(x);
    const y = dec(c);
    codes.push(c);
    decoded.push(y);
    sig += x * x;
    noise += (x - y) * (x - y);
  }
  return { codes, decoded, snrDb: noise === 0 ? Infinity : 10 * Math.log10(sig / noise) };
}

/** Sine generator straight to A-law bytes: what a "voice" time slot carries. */
export function toneAlaw(freqHz: number, amplitude: number, startSample: number, count: number): number[] {
  const out: number[] = [];
  for (let n = 0; n < count; n++) {
    out.push(linearToAlaw(amplitude * Math.sin((2 * Math.PI * freqHz * (startSample + n)) / SAMPLE_RATE)));
  }
  return out;
}
