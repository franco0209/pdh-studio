/**
 * The three plesiochronous hierarchies (ITU-T G.702) and the cost of reaching one E1
 * inside a high-order stream, which is what makes PDH expensive to operate.
 */

export interface Level {
  level: number;
  name: string;
  kbps: number;
  channels: number;
}

export const HIERARCHY = {
  europe: [
    { level: 1, name: 'E1', kbps: 2048, channels: 30 },
    { level: 2, name: 'E2', kbps: 8448, channels: 120 },
    { level: 3, name: 'E3', kbps: 34368, channels: 480 },
    { level: 4, name: 'E4', kbps: 139264, channels: 1920 },
    { level: 5, name: 'E5', kbps: 565148, channels: 7680 },
  ],
  northAmerica: [
    { level: 1, name: 'DS1', kbps: 1544, channels: 24 },
    { level: 2, name: 'DS2', kbps: 6312, channels: 96 },
    { level: 3, name: 'DS3', kbps: 44736, channels: 672 },
    { level: 4, name: 'DS4', kbps: 274176, channels: 4032 },
  ],
  japan: [
    { level: 1, name: 'J1', kbps: 1544, channels: 24 },
    { level: 2, name: 'J2', kbps: 6312, channels: 96 },
    { level: 3, name: 'J3', kbps: 32064, channels: 480 },
    { level: 4, name: 'J4', kbps: 97728, channels: 1440 },
    { level: 5, name: 'J5', kbps: 397200, channels: 5760 },
  ],
} satisfies Record<string, Level[]>;

export type Region = keyof typeof HIERARCHY;

/** Share of a level's line rate that is not payload from the level below (overhead + justification). */
export function overheadPct(region: Region, level: number): number {
  const L = HIERARCHY[region];
  const hi = L[level - 1]!;
  const lo = L[level - 2];
  if (!lo) return 0;
  const factor = Math.round(hi.channels / lo.channels);
  const payload = factor * lo.kbps;
  return ((hi.kbps - payload) / hi.kbps) * 100;
}

/** Worst-case frequency difference, bit/s, between a nominal E1 and one at the E1 tolerance. */
export const E1_PPM_BPS = (2048000 * 50) / 1e6;

/** Number of E1 hanging from one stream of the given level (E2 -> 4, E3 -> 16, E4 -> 64). */
export const E1_PER_LEVEL: Record<number, number> = { 1: 1, 2: 4, 3: 16, 4: 64 };

export interface AddDropCost {
  /** Multiplexer + demultiplexer units needed to drop and insert the given E1 at a node. */
  pdhUnits: number;
  pdhDemux: number;
  pdhMux: number;
  /** An SDH add-drop multiplexer reaches the tributary through its pointer: one unit. */
  sdhUnits: number;
  /** Frames of delay added by the cascade (each stage buffers about one frame of its level). */
  pdhDelayUs: number;
  sdhDelayUs: number;
}

/** Frame period of each PDH level in microseconds (frame bits / line rate). */
export const FRAME_US: Record<number, number> = {
  1: 125,
  2: (848 / 8448000) * 1e6,
  3: (1536 / 34368000) * 1e6,
  4: (2928 / 139264000) * 1e6,
};

/**
 * Cost of dropping (and re-inserting) E1 circuits at a node that sits on a stream of `level`
 * (2 = E2, 3 = E3, 4 = E4). `slots` are the E1 positions (0..63 for E4) of the circuits that
 * leave or enter at this node; everything else passes through.
 *
 * In PDH the stream must be demultiplexed level by level down to the E1 and multiplexed back
 * up again, but only along the branches of the tree that contain a dropped E1. Circuits grouped in
 * the same branch share demultiplexers; circuits scattered over the stream pay for each branch.
 */
export function addDropCost(level: number, slots: number[]): AddDropCost {
  const uniq = [...new Set(slots)];
  if (uniq.length === 0) return { pdhUnits: 0, pdhDemux: 0, pdhMux: 0, sdhUnits: 0, pdhDelayUs: 0, sdhDelayUs: 0 };
  let units = 0;
  let delay = 0;
  // stage s demultiplexes level s+1 -> s ; branches touched at each level
  for (let lv = level; lv >= 2; lv--) {
    const span = E1_PER_LEVEL[lv]!; // E1 below one stream of this level
    const branches = new Set(uniq.map((s) => Math.floor(s / span)));
    units += branches.size;
    delay += branches.size > 0 ? FRAME_US[lv]! : 0;
  }
  return {
    pdhUnits: units * 2,
    pdhDemux: units,
    pdhMux: units,
    sdhUnits: 1,
    pdhDelayUs: delay * 2,
    sdhDelayUs: FRAME_US[1]!,
  };
}
