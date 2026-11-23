/**
 * Plesiochronous multiplexers with positive justification (bit stuffing).
 *
 *   2/8   : 4 x E1 (2 048)  -> E2 (8 448)    ITU-T G.742, 848-bit frame
 *   8/34  : 4 x E2 (8 448)  -> E3 (34 368)   ITU-T G.751, 1 536-bit frame
 *   34/140: 4 x E3 (34 368) -> E4 (139 264)  ITU-T G.751, 2 928-bit frame
 *
 * Every tributary has its own clock (within +-ppm of nominal), the multiplexer has another.
 * Each frame offers one justification opportunity (S bit) per tributary. The Cj control bits
 * tell the demultiplexer whether S carried data (Cj = 0...0) or was stuffed (Cj = 1...1); it
 * decides by majority vote so a line error in Cj does not lose the bit.
 */
import { bitOf, makeSym, type Sym } from './bits';

export type CellKind = 'fas' | 'alarm' | 'national' | 'reserved' | 'cj' | 'stuff' | 'data';

export interface Layout {
  kind: Uint8Array;
  trib: Uint8Array;
  /** For Cj cells: which control bit (0-based). For FAS cells: bit index inside the FAS word. */
  idx: Uint8Array;
}

const KINDS: CellKind[] = ['fas', 'alarm', 'national', 'reserved', 'cj', 'stuff', 'data'];
export const kindName = (code: number): CellKind => KINDS[code]!;
const K = Object.fromEntries(KINDS.map((k, i) => [k, i])) as Record<CellKind, number>;

export interface MuxSpec {
  id: 'E2' | 'E3' | 'E4';
  name: string;
  recommendation: string;
  lineRate: number;
  tribRate: number;
  frameBits: number;
  tribs: number;
  fas: number[];
  /** Number of Cj bits per tributary and frame (3 -> 2-of-3 vote, 5 -> 3-of-5). */
  cjBits: number;
  /** Tolerance of the line clock and of the tributary clocks, ppm. */
  tolerancePpm: number;
  /** Bits of data offered to each tributary every frame, without the justification slot. */
  dataPerTrib: number;
  layout: Layout;
}

interface Set {
  /** Cells of this set that are not data, in order. */
  head: { kind: CellKind; idx?: number; perTrib?: boolean }[];
  length: number;
}

function buildLayout(frameBits: number, tribs: number, sets: Set[], fasLen: number): Layout {
  const kind = new Uint8Array(frameBits);
  const trib = new Uint8Array(frameBits);
  const idx = new Uint8Array(frameBits);
  let pos = 0;
  for (const s of sets) {
    const start = pos;
    for (const h of s.head) {
      if (h.perTrib) {
        for (let t = 0; t < tribs; t++) {
          kind[pos] = K[h.kind];
          trib[pos] = t;
          idx[pos] = h.idx ?? 0;
          pos++;
        }
      } else {
        kind[pos] = K[h.kind];
        idx[pos] = h.kind === 'fas' ? pos - start : (h.idx ?? 0);
        pos++;
      }
    }
    let t = 0;
    while (pos < start + s.length) {
      kind[pos] = K.data;
      trib[pos] = t;
      t = (t + 1) % tribs;
      pos++;
    }
  }
  if (pos !== frameBits) throw new Error(`layout has ${pos} bits, expected ${frameBits}`);
  void fasLen;
  return { kind, trib, idx };
}

const fasHead = (n: number) => Array.from({ length: n }, () => ({ kind: 'fas' as CellKind }));
const cj = (j: number) => ({ kind: 'cj' as CellKind, idx: j, perTrib: true });
const stuff = { kind: 'stuff' as CellKind, perTrib: true };

function countData(layout: Layout, t: number): number {
  let n = 0;
  for (let i = 0; i < layout.kind.length; i++) if (layout.kind[i] === K.data && layout.trib[i] === t) n++;
  return n;
}

function make(spec: Omit<MuxSpec, 'layout' | 'dataPerTrib'>, sets: Set[]): MuxSpec {
  const layout = buildLayout(spec.frameBits, spec.tribs, sets, spec.fas.length);
  return { ...spec, layout, dataPerTrib: countData(layout, 0) };
}

export const E2_SPEC: MuxSpec = make(
  {
    id: 'E2',
    name: '2/8',
    recommendation: 'ITU-T G.742',
    lineRate: 8_448_000,
    tribRate: 2_048_000,
    frameBits: 848,
    tribs: 4,
    fas: [1, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    cjBits: 3,
    tolerancePpm: 30,
  },
  [
    { head: [...fasHead(10), { kind: 'alarm' }, { kind: 'national' }], length: 212 },
    { head: [cj(0)], length: 212 },
    { head: [cj(1)], length: 212 },
    { head: [cj(2), stuff], length: 212 },
  ],
);

export const E3_SPEC: MuxSpec = make(
  {
    id: 'E3',
    name: '8/34',
    recommendation: 'ITU-T G.751',
    lineRate: 34_368_000,
    tribRate: 8_448_000,
    frameBits: 1536,
    tribs: 4,
    fas: [1, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    cjBits: 3,
    tolerancePpm: 20,
  },
  [
    { head: [...fasHead(10), { kind: 'alarm' }, { kind: 'national' }], length: 384 },
    { head: [cj(0)], length: 384 },
    { head: [cj(1)], length: 384 },
    { head: [cj(2), stuff], length: 384 },
  ],
);

export const E4_SPEC: MuxSpec = make(
  {
    id: 'E4',
    name: '34/140',
    recommendation: 'ITU-T G.751',
    lineRate: 139_264_000,
    tribRate: 34_368_000,
    frameBits: 2928,
    tribs: 4,
    fas: [1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0],
    cjBits: 5,
    tolerancePpm: 15,
  },
  [
    {
      head: [...fasHead(12), { kind: 'alarm' }, { kind: 'national' }, { kind: 'reserved' }, { kind: 'reserved' }],
      length: 488,
    },
    { head: [cj(0)], length: 488 },
    { head: [cj(1)], length: 488 },
    { head: [cj(2)], length: 488 },
    { head: [cj(3)], length: 488 },
    { head: [cj(4), stuff], length: 488 },
  ],
);

export const SPECS = { E2: E2_SPEC, E3: E3_SPEC, E4: E4_SPEC } as const;

/** Nominal stuffing ratio: share of frames in which S is stuffing, for nominal clocks. */
export function nominalStuffRatio(spec: MuxSpec): number {
  const bitsPerFrame = (spec.tribRate * spec.frameBits) / spec.lineRate;
  return spec.dataPerTrib + 1 - bitsPerFrame;
}

export const framesPerSecond = (spec: MuxSpec): number => spec.lineRate / spec.frameBits;

/** Longest ppm offset between a tributary and the multiplexer for which justification still works. */
export function justificationRangePpm(spec: MuxSpec): { minBitsPerFrame: number; maxBitsPerFrame: number; lowPpm: number; highPpm: number } {
  const nom = (spec.tribRate * spec.frameBits) / spec.lineRate;
  const lo = spec.dataPerTrib;
  const hi = spec.dataPerTrib + 1;
  return { minBitsPerFrame: lo, maxBitsPerFrame: hi, lowPpm: (lo / nom - 1) * 1e6, highPpm: (hi / nom - 1) * 1e6 };
}

/** Anything that can hand out the next n symbols of a tributary. */
export interface SymSource {
  pull(n: number): Sym[];
}

export interface MuxOptions {
  /** Clock error of the multiplexer's own line clock, ppm. */
  linePpm?: number;
  /** Clock error of each tributary, ppm (the real rate of the stream the source produces). */
  tribPpm?: number[];
  /** Alarm indication bit sent to the far end. */
  alarm?: boolean;
}

export interface MuxFrame {
  symbols: Sym[];
  /** true per tributary when its S bit was stuffing (Cj all ones). */
  stuffed: boolean[];
  index: number;
  /** Buffer fill of every tributary at the start of the frame, in bits. */
  fill: number[];
}

/** One justification multiplexer. Call `nextFrame()` once per line frame. */
export class JustMux {
  readonly spec: MuxSpec;
  private readonly sources: SymSource[];
  private readonly opts: Required<MuxOptions>;
  private frame = 0;
  private readonly consumed: number[];
  private readonly prefill: number;

  constructor(spec: MuxSpec, sources: SymSource[], opts: MuxOptions = {}) {
    if (sources.length !== spec.tribs) throw new Error(`${spec.id} needs ${spec.tribs} tributaries`);
    this.spec = spec;
    this.sources = sources;
    this.opts = {
      linePpm: opts.linePpm ?? 0,
      tribPpm: opts.tribPpm ?? Array(spec.tribs).fill(0),
      alarm: opts.alarm ?? false,
    };
    this.consumed = Array(spec.tribs).fill(0);
    // The elastic store starts with data already in it so the first frame never underflows.
    this.prefill = spec.dataPerTrib + 2;
  }

  get frameIndex(): number {
    return this.frame;
  }

  /** Real line rate of this multiplexer, bit/s. */
  get lineRate(): number {
    return this.spec.lineRate * (1 + this.opts.linePpm * 1e-6);
  }

  /** Real rate a tributary arrives at, bit/s. */
  tribRate(t: number): number {
    return this.spec.tribRate * (1 + (this.opts.tribPpm[t] ?? 0) * 1e-6);
  }

  setAlarm(on: boolean): void {
    this.opts.alarm = on;
  }

  nextFrame(): MuxFrame {
    const { spec } = this;
    const { kind, trib, idx } = spec.layout;
    const timeS = (this.frame * spec.frameBits) / this.lineRate;
    const stuffed: boolean[] = [];
    const fill: number[] = [];
    const got: Sym[][] = [];
    const ptr: number[] = Array(spec.tribs).fill(0);

    for (let t = 0; t < spec.tribs; t++) {
      const arrived = Math.floor(this.prefill + this.tribRate(t) * timeS);
      const level = arrived - this.consumed[t]!;
      fill.push(level);
      // Send data in S only when the store holds more than one frame's worth plus the extra bit.
      const useS = level - spec.dataPerTrib >= 1;
      stuffed.push(!useS);
      const need = spec.dataPerTrib + (useS ? 1 : 0);
      got.push(this.sources[t]!.pull(need));
      this.consumed[t]! += need;
    }

    const out: Sym[] = new Array(spec.frameBits);
    for (let i = 0; i < spec.frameBits; i++) {
      const t = trib[i]!;
      switch (kind[i]) {
        case K.fas:
          out[i] = makeSym(spec.fas[idx[i]!]!);
          break;
        case K.alarm:
          out[i] = makeSym(this.opts.alarm ? 1 : 0);
          break;
        case K.national:
        case K.reserved:
          out[i] = makeSym(1);
          break;
        case K.cj:
          out[i] = makeSym(stuffed[t] ? 1 : 0);
          break;
        case K.stuff:
          out[i] = stuffed[t] ? makeSym(0) : got[t]![ptr[t]!++]!;
          break;
        default:
          out[i] = got[t]![ptr[t]!++]!;
      }
    }
    return { symbols: out, stuffed, index: this.frame++, fill };
  }
}

export interface DemuxFrame {
  tribs: Sym[][];
  fasOk: boolean;
  alarm: boolean;
  /** Tributaries whose Cj bits were not unanimous (an error that the vote corrected or not). */
  cjDisagreements: number;
  stuffed: boolean[];
}

export function demuxFrame(spec: MuxSpec, frame: ArrayLike<Sym>): DemuxFrame {
  const { kind, trib, idx } = spec.layout;
  const cjSum: number[] = Array(spec.tribs).fill(0);
  let fasOk = true;
  let alarm = false;
  for (let i = 0; i < spec.frameBits; i++) {
    if (kind[i] === K.fas && bitOf(frame[i]!) !== spec.fas[idx[i]!]) fasOk = false;
    else if (kind[i] === K.alarm) alarm = bitOf(frame[i]!) === 1;
    else if (kind[i] === K.cj) cjSum[trib[i]!]! += bitOf(frame[i]!);
  }
  const stuffed = cjSum.map((s) => s * 2 > spec.cjBits);
  const cjDisagreements = cjSum.filter((s) => s !== 0 && s !== spec.cjBits).length;
  const tribs: Sym[][] = Array.from({ length: spec.tribs }, () => []);
  for (let i = 0; i < spec.frameBits; i++) {
    if (kind[i] === K.data) tribs[trib[i]!]!.push(frame[i]!);
    else if (kind[i] === K.stuff && !stuffed[trib[i]!]) tribs[trib[i]!]!.push(frame[i]!);
  }
  return { tribs, fasOk, alarm, cjDisagreements, stuffed };
}

/** Wraps a multiplexer as a source of bits for the next level up. */
export class MuxLineSource implements SymSource {
  private buf: Sym[] = [];
  private head = 0;
  constructor(
    readonly mux: JustMux,
    private readonly onFrame?: (f: MuxFrame) => void,
  ) {}
  pull(n: number): Sym[] {
    while (this.buf.length - this.head < n) {
      if (this.head > 65536) {
        this.buf = this.buf.slice(this.head);
        this.head = 0;
      }
      const f = this.mux.nextFrame();
      this.onFrame?.(f);
      for (const s of f.symbols) this.buf.push(s);
    }
    const out = this.buf.slice(this.head, this.head + n);
    this.head += n;
    return out;
  }
}
