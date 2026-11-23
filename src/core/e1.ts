/**
 * E1 (2 048 kbit/s) framing, ITU-T G.704 / G.706 / G.732.
 *
 * 32 time slots x 8 bits = 256 bits every 125 us. TS0 carries alignment (FAS/NFAS)
 * and, with CRC-4 enabled, a 16-frame multiframe with error detection. TS16 carries
 * channel-associated (CAS) or common-channel (CCS) signalling. Bits are listed in
 * transmission order (bit 1 of every time slot first).
 */
import { bitsToByte } from './bits';

export const E1_FRAME_BITS = 256;
export const E1_RATE = 2_048_000;
export const E1_FRAMES_PER_SECOND = 8000;
export const E1_PAYLOAD_TS = [...Array(15).keys()].map((i) => i + 1).concat([...Array(15).keys()].map((i) => i + 17));

/** FAS bits 2..8 of TS0 in even frames. */
export const FAS_PATTERN = [0, 0, 1, 1, 0, 1, 1];
/** Si bits of the odd frames 1,3,5,7,9,11 form the CRC-4 multiframe alignment word. */
export const MFAS_PATTERN = [0, 0, 1, 0, 1, 1];

/** CRC-4 with generator x^4 + x + 1: remainder of M(x)·x^4. C1 is the most significant bit. */
export function crc4(bits: ArrayLike<number>): number {
  let reg = 0;
  for (let i = 0; i < bits.length; i++) {
    const fb = ((reg >> 3) & 1) ^ (bits[i]! & 1);
    reg = (reg << 1) & 0xf;
    if (fb) reg ^= 0b0011;
  }
  return reg;
}

export interface E1Config {
  crc4: boolean;
  /** true: CAS multiframe in TS16, false: common channel signalling (HDLC flags when idle). */
  cas: boolean;
  /** Remote alarm indication sent to the far end (bit A of TS0 in odd frames). */
  rai?: boolean;
  /** E bits sent back about the received CRC-4 blocks (1 = block received without error). */
  eBits?: [number, number];
  /** Spare bits Sa4..Sa8, default all 1. */
  sa?: number[];
}

export interface E1FrameInfo {
  frameInMultiframe: number;
  bits: Uint8Array;
}

/**
 * Builds E1 frames one after another and keeps the CRC-4 state across them.
 * `payload(ch)` gives the byte of B channel `ch` (1..30) for the current frame.
 */
export class E1Framer {
  private n = 0;
  private crcReg = 0;
  private pendingCrc = 0;
  private readonly cfg: E1Config;
  /** ABCD signalling nibbles of the 30 channels (CAS only). Default: idle 1101. */
  signalling: number[] = Array(30).fill(0b1101);

  constructor(cfg: E1Config) {
    this.cfg = cfg;
  }

  get frameNumber(): number {
    return this.n;
  }

  nextFrame(payload: (ch: number) => number): E1FrameInfo {
    const fm = this.n % 16;
    const out = new Uint8Array(E1_FRAME_BITS);
    const rai = this.cfg.rai ? 1 : 0;
    const sa = this.cfg.sa ?? [1, 1, 1, 1, 1];

    // TS0
    const ts0 = new Array<number>(8);
    if (fm % 2 === 0) {
      ts0[0] = this.cfg.crc4 ? this.crcBitForFrame(fm) : 1;
      for (let i = 0; i < 7; i++) ts0[i + 1] = FAS_PATTERN[i]!;
    } else {
      if (this.cfg.crc4) {
        if (fm === 13) ts0[0] = (this.cfg.eBits ?? [1, 1])[0];
        else if (fm === 15) ts0[0] = (this.cfg.eBits ?? [1, 1])[1];
        else ts0[0] = MFAS_PATTERN[(fm - 1) / 2]!;
      } else ts0[0] = 1;
      ts0[1] = 1;
      ts0[2] = rai;
      for (let i = 0; i < 5; i++) ts0[3 + i] = sa[i] ?? 1;
    }
    for (let i = 0; i < 8; i++) out[i] = ts0[i]!;

    // Payload TS1..15, TS17..31
    let ch = 1;
    for (let ts = 1; ts < 32; ts++) {
      if (ts === 16) continue;
      const byte = payload(ch++) & 0xff;
      for (let i = 0; i < 8; i++) out[ts * 8 + i] = (byte >> (7 - i)) & 1;
    }

    // TS16
    const ts16 = this.cfg.cas ? this.casByte(fm) : 0x7e;
    for (let i = 0; i < 8; i++) out[16 * 8 + i] = (ts16 >> (7 - i)) & 1;

    // CRC-4 runs over the 2048 bits of each submultiframe with the C bits forced to 0.
    if (this.cfg.crc4) {
      let reg = this.crcReg;
      for (let i = 0; i < E1_FRAME_BITS; i++) {
        const b = i === 0 && fm % 2 === 0 ? 0 : out[i]!;
        const fb = ((reg >> 3) & 1) ^ b;
        reg = (reg << 1) & 0xf;
        if (fb) reg ^= 0b0011;
      }
      this.crcReg = reg;
      if (fm === 7 || fm === 15) {
        this.pendingCrc = reg;
        this.crcReg = 0;
      }
    }
    this.n++;
    return { frameInMultiframe: fm, bits: out };
  }

  /** C1..C4 of this frame: they carry the CRC of the *previous* submultiframe. */
  private crcBitForFrame(fm: number): number {
    const k = (fm % 8) / 2; // 0..3 -> C1..C4
    return (this.pendingCrcForTx() >> (3 - k)) & 1;
  }

  private txCrc = 0;
  private pendingCrcForTx(): number {
    // The CRC computed at the end of SMF N is sent during SMF N+1.
    const fm = this.n % 16;
    if (fm === 0 || fm === 8) this.txCrc = this.pendingCrc;
    return this.txCrc;
  }

  private casByte(fm: number): number {
    if (fm === 0) return 0b00001011; // MAS 0000, X=1 Y=0 X=1 X=1
    const hi = this.signalling[fm - 1]! & 0xf; // channel fm
    const lo = this.signalling[fm + 14]! & 0xf; // channel fm + 15
    return (hi << 4) | lo;
  }
}

export interface E1Analysis {
  /** Bit offset where frame alignment was found, -1 when it could not be found. */
  offset: number;
  frames: number;
  fasErrors: number;
  /** Frame alignment lost: three consecutive wrong alignment words (G.706). */
  lof: boolean;
  /** Offset (in frames) of the CRC-4 multiframe, -1 if absent. */
  multiframeOffset: number;
  crcBlocks: number;
  crcErrors: number;
  /** Far-end alarm bit seen in at least one NFAS. */
  rai: boolean;
  /** E bits received as 0: the far end saw errored blocks coming from us. */
  febe: number;
}

function wordOk(bits: ArrayLike<number>, base: number, even: boolean): boolean {
  if (even) {
    for (let i = 0; i < 7; i++) if (bits[base + 1 + i] !== FAS_PATTERN[i]) return false;
    return true;
  }
  return bits[base + 1] === 1;
}

/** Hunt for frame alignment like G.706: FAS, then bit 2 = 1 in the next frame, then FAS again. */
export function findE1Alignment(bits: ArrayLike<number>, maxSearch = 512): number {
  const limit = Math.min(maxSearch, bits.length - 3 * E1_FRAME_BITS);
  for (let o = 0; o < limit; o++) {
    if (
      wordOk(bits, o, true) &&
      wordOk(bits, o + E1_FRAME_BITS, false) &&
      wordOk(bits, o + 2 * E1_FRAME_BITS, true) &&
      wordOk(bits, o + 3 * E1_FRAME_BITS, false)
    ) {
      return o;
    }
  }
  return -1;
}

/** Analyse a captured E1 bit stream: alignment, CRC-4 multiframe, CRC errors, alarm bits. */
export function analyzeE1(bits: ArrayLike<number>): E1Analysis {
  const offset = findE1Alignment(bits);
  const empty: E1Analysis = {
    offset,
    frames: 0,
    fasErrors: 0,
    lof: true,
    multiframeOffset: -1,
    crcBlocks: 0,
    crcErrors: 0,
    rai: false,
    febe: 0,
  };
  if (offset < 0) return empty;
  const frames = Math.floor((bits.length - offset) / E1_FRAME_BITS);
  let fasErrors = 0;
  // G.706: alignment is lost after 3 consecutive wrong FAS words, or 3 consecutive wrong NFAS bit 2.
  let badFas = 0;
  let badNfas = 0;
  let lof = false;
  let rai = false;
  for (let f = 0; f < frames; f++) {
    const base = offset + f * E1_FRAME_BITS;
    const even = f % 2 === 0;
    if (!wordOk(bits, base, even)) {
      fasErrors++;
      if (even) {
        if (++badFas >= 3) lof = true;
      } else if (++badNfas >= 3) lof = true;
    } else if (even) badFas = 0;
    else badNfas = 0;
    if (!even && bits[base + 2] === 1) rai = true;
  }

  // CRC-4 multiframe alignment: look for 001011 in the Si bit of frames 1,3,5,7,9,11.
  let mf = -1;
  for (let p = 0; p < 16 && mf < 0; p += 1) {
    if (p % 2 !== 0) continue; // multiframe starts on an even frame
    let ok = frames >= p + 32;
    for (let m = 0; ok && m < 2; m++) {
      for (let k = 0; k < 6; k++) {
        const f = p + 16 * m + 1 + 2 * k;
        if (bits[offset + f * E1_FRAME_BITS] !== MFAS_PATTERN[k]) {
          ok = false;
          break;
        }
      }
    }
    if (ok) mf = p;
  }

  let crcBlocks = 0;
  let crcErrors = 0;
  let febe = 0;
  if (mf >= 0) {
    const blocks = Math.floor((frames - mf) / 8);
    for (let b = 0; b + 1 < blocks; b++) {
      // submultiframe b is checked against the C bits in submultiframe b+1
      const start = mf + b * 8;
      const calc: number[] = [];
      for (let f = 0; f < 8; f++) {
        const base = offset + (start + f) * E1_FRAME_BITS;
        for (let i = 0; i < E1_FRAME_BITS; i++) calc.push(i === 0 && f % 2 === 0 ? 0 : bits[base + i]!);
      }
      const nextStart = start + 8;
      let rx = 0;
      for (let k = 0; k < 4; k++) rx = (rx << 1) | bits[offset + (nextStart + 2 * k) * E1_FRAME_BITS]!;
      crcBlocks++;
      if (crc4(calc) !== rx) crcErrors++;
    }
    for (let m = 0; m * 16 + mf + 15 < frames; m++) {
      if (bits[offset + (mf + 16 * m + 13) * E1_FRAME_BITS] === 0) febe++;
      if (bits[offset + (mf + 16 * m + 15) * E1_FRAME_BITS] === 0) febe++;
    }
  }

  return { offset, frames, fasErrors, lof, multiframeOffset: mf, crcBlocks, crcErrors, rai, febe };
}

/** Pull the 30 payload bytes of one aligned frame out of a bit stream. */
export function frameBytes(bits: ArrayLike<number>, base: number): number[] {
  const out: number[] = [];
  for (const ts of E1_PAYLOAD_TS) out.push(bitsToByte(bits, base + ts * 8));
  return out;
}

/** Alarm conditions on an incoming line (G.775 style thresholds, configurable). */
export interface LineAlarms {
  los: boolean;
  ais: boolean;
}

export function detectLineAlarms(pulses: ArrayLike<number>, bits: ArrayLike<number>, losZeros = 255): LineAlarms {
  let run = 0;
  let los = false;
  for (let i = 0; i < pulses.length; i++) {
    if (pulses[i] === 0) {
      if (++run >= losZeros) {
        los = true;
        break;
      }
    } else run = 0;
  }
  // AIS: at most 2 zeros in a window of 512 bits (two frames)
  let ais = false;
  if (!los && bits.length >= 512) {
    let zeros = 0;
    for (let i = 0; i < 512; i++) if (bits[i] === 0) zeros++;
    ais = zeros <= 2;
  }
  return { los, ais };
}
