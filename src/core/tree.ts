/**
 * A complete multiplexer tree, from E1 sources up to E2, E3 or E4, plus the matching
 * demultiplexer. Used by the lab, the bit map and the tests.
 */
import { bitOf, makeSym, makeTag, rng, tagOf, flipSym, Prbs, type Sym } from './bits';
import { E1Framer, type E1Config } from './e1';
import { alawToLinear, linearToAlaw } from './pcm';
import { demuxFrame, E2_SPEC, E3_SPEC, E4_SPEC, JustMux, MuxLineSource, type MuxFrame, type MuxSpec, type SymSource } from './mux';

export type TopLevel = 'E2' | 'E3' | 'E4';
export type E1Content = 'prbs' | 'tone' | 'idle';

export interface E1SourceConfig extends E1Config {
  content: E1Content;
  /** Tone frequency in Hz for the 'tone' content (each channel is offset a little). */
  toneHz?: number;
}

/** A synthetic E1 line: framed with G.704 and carrying the chosen traffic, every bit tagged. */
export class E1Source implements SymSource {
  readonly framer: E1Framer;
  private bitIndex = 0;
  private buf: number[] = [];
  private head = 0;
  private readonly prbs: Prbs;
  private sample = 0;

  constructor(
    readonly src: number,
    readonly cfg: E1SourceConfig,
  ) {
    this.framer = new E1Framer(cfg);
    this.prbs = new Prbs(15, 0x1abc + src * 97);
  }

  private payloadByte(ch: number): number {
    switch (this.cfg.content) {
      case 'idle':
        return 0xd5;
      case 'tone': {
        const f = (this.cfg.toneHz ?? 440) + (ch - 1) * 20 + this.src * 3;
        return linearToAlaw(8000 * Math.sin((2 * Math.PI * f * this.sample) / 8000));
      }
      default: {
        let b = 0;
        for (let i = 0; i < 8; i++) b = (b << 1) | this.prbs.next();
        return b;
      }
    }
  }

  pull(n: number): Sym[] {
    while (this.buf.length - this.head < n) {
      if (this.head > 65536) {
        this.buf = this.buf.slice(this.head);
        this.head = 0;
      }
      const f = this.framer.nextFrame((ch) => this.payloadByte(ch));
      this.sample++;
      for (let i = 0; i < 256; i++) this.buf.push(makeSym(f.bits[i]!, makeTag(this.src, this.bitIndex++)));
    }
    const out = this.buf.slice(this.head, this.head + n);
    this.head += n;
    return out;
  }
}

export interface TreeOptions {
  top: TopLevel;
  /** Clock error of every E1 source, ppm (index = E1 number). Missing entries are 0. */
  e1Ppm?: number[];
  /** Line clock error of the E2 multiplexers (index = E2 number), the E3 ones and the E4 one. */
  e2Ppm?: number[];
  e3Ppm?: number[];
  e4Ppm?: number;
  e1?: Partial<E1SourceConfig>;
}

export interface LevelStats {
  frames: number;
  /** Per multiplexer, per tributary: number of frames in which S was stuffing. */
  stuffed: number[][];
}

export interface PdhTree {
  top: JustMux;
  spec: MuxSpec;
  e1: E1Source[];
  e2: JustMux[];
  e3: JustMux[];
  stats: { E2: LevelStats; E3: LevelStats; E4: LevelStats };
  nextTopFrame(): MuxFrame;
}

export const E1_COUNT: Record<TopLevel, number> = { E2: 4, E3: 16, E4: 64 };

export function buildTree(opts: TreeOptions): PdhTree {
  const { top } = opts;
  const nE1 = E1_COUNT[top];
  const e1Cfg: E1SourceConfig = { crc4: true, cas: false, content: 'prbs', ...opts.e1 };
  const e1 = Array.from({ length: nE1 }, (_, i) => new E1Source(i, e1Cfg));
  const ppm = (arr: number[] | undefined, i: number) => arr?.[i] ?? 0;
  const stats = {
    E2: { frames: 0, stuffed: [] as number[][] },
    E3: { frames: 0, stuffed: [] as number[][] },
    E4: { frames: 0, stuffed: [] as number[][] },
  };
  const track = (lvl: LevelStats, m: number) => (f: MuxFrame) => {
    if (m === 0) lvl.frames++;
    const row = (lvl.stuffed[m] ??= Array(4).fill(0));
    f.stuffed.forEach((s, t) => {
      if (s) row[t]!++;
    });
  };

  const e2: JustMux[] = [];
  const e2Src: MuxLineSource[] = [];
  for (let m = 0; m < nE1 / 4; m++) {
    const mux = new JustMux(E2_SPEC, e1.slice(m * 4, m * 4 + 4), {
      linePpm: ppm(opts.e2Ppm, m),
      tribPpm: [0, 1, 2, 3].map((t) => ppm(opts.e1Ppm, m * 4 + t)),
    });
    e2.push(mux);
    e2Src.push(new MuxLineSource(mux, track(stats.E2, m)));
  }

  if (top === 'E2') {
    const trackTop = track(stats.E2, 0);
    return {
      top: e2[0]!,
      spec: E2_SPEC,
      e1,
      e2,
      e3: [],
      stats,
      nextTopFrame: () => {
        const f = e2[0]!.nextFrame();
        trackTop(f);
        return f;
      },
    };
  }

  const e3: JustMux[] = [];
  const e3Src: MuxLineSource[] = [];
  for (let m = 0; m < e2.length / 4; m++) {
    const mux = new JustMux(E3_SPEC, e2Src.slice(m * 4, m * 4 + 4), {
      linePpm: ppm(opts.e3Ppm, m),
      tribPpm: [0, 1, 2, 3].map((t) => ppm(opts.e2Ppm, m * 4 + t)),
    });
    e3.push(mux);
    e3Src.push(new MuxLineSource(mux, track(stats.E3, m)));
  }

  if (top === 'E3') {
    const trackTop = track(stats.E3, 0);
    return {
      top: e3[0]!,
      spec: E3_SPEC,
      e1,
      e2,
      e3,
      stats,
      nextTopFrame: () => {
        const f = e3[0]!.nextFrame();
        trackTop(f);
        return f;
      },
    };
  }

  const e4 = new JustMux(E4_SPEC, e3Src, {
    linePpm: opts.e4Ppm ?? 0,
    tribPpm: [0, 1, 2, 3].map((t) => ppm(opts.e3Ppm, t)),
  });
  const trackE4 = track(stats.E4, 0);
  return {
    top: e4,
    spec: E4_SPEC,
    e1,
    e2,
    e3,
    stats,
    nextTopFrame: () => {
      const f = e4.nextFrame();
      trackE4(f);
      return f;
    },
  };
}

/** Demultiplex a stream of frames of `spec` into its four tributary streams. */
export function demuxStream(spec: MuxSpec, frames: Sym[][]): { tribs: Sym[][]; fasErrors: number; cjDisagreements: number } {
  const tribs: Sym[][] = [[], [], [], []];
  let fasErrors = 0;
  let cjDisagreements = 0;
  for (const f of frames) {
    const d = demuxFrame(spec, f);
    if (!d.fasOk) fasErrors++;
    cjDisagreements += d.cjDisagreements;
    d.tribs.forEach((t, i) => {
      for (const s of t) tribs[i]!.push(s);
    });
  }
  return { tribs, fasErrors, cjDisagreements };
}

export function cutFrames(stream: Sym[], frameBits: number): Sym[][] {
  const out: Sym[][] = [];
  for (let i = 0; i + frameBits <= stream.length; i += frameBits) out.push(stream.slice(i, i + frameBits));
  return out;
}

/** Full demultiplexing of the top level down to every E1, in E1-number order. */
export function demuxTree(top: TopLevel, frames: Sym[][]): Sym[][] {
  if (top === 'E2') return demuxStream(E2_SPEC, frames).tribs;
  if (top === 'E3') {
    const lvl = demuxStream(E3_SPEC, frames).tribs; // 4 E2 streams
    return lvl.flatMap((s) => demuxStream(E2_SPEC, cutFrames(s, E2_SPEC.frameBits)).tribs);
  }
  const e3 = demuxStream(E4_SPEC, frames).tribs;
  const e2 = e3.flatMap((s) => demuxStream(E3_SPEC, cutFrames(s, E3_SPEC.frameBits)).tribs);
  return e2.flatMap((s) => demuxStream(E2_SPEC, cutFrames(s, E2_SPEC.frameBits)).tribs);
}

/** Flip random bits of a line (frames in place) with the given bit error ratio. Returns how many. */
export function injectErrors(frames: Sym[][], ber: number, seed = 1): number {
  if (ber <= 0) return 0;
  const rand = rng(seed);
  let count = 0;
  for (const f of frames) {
    // geometric skipping keeps this fast for tiny ratios
    let i = Math.floor(Math.log(1 - rand()) / Math.log(1 - ber));
    while (i < f.length) {
      f[i] = flipSym(f[i]!);
      count++;
      i += 1 + Math.floor(Math.log(1 - rand()) / Math.log(1 - ber));
    }
  }
  return count;
}

/** Hamming-style check: do the recovered symbols equal the originals, bit and origin tag? */
export function sameStream(a: Sym[], b: Sym[], n = Math.min(a.length, b.length)): boolean {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

export { alawToLinear, bitOf, tagOf };
