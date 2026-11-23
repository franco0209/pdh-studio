import { describe, expect, it } from 'vitest';
import { E1_RATE } from './e1';
import { measureWaitingJitterUi, offsetBps, simulateElasticBuffer, slipIntervalSeconds, tieUi } from './clock';
import { addDropCost, E1_PER_LEVEL, FRAME_US, HIERARCHY, overheadPct } from './hierarchy';
import {
  analyticPerformance,
  berQpsk,
  blockErrorProbability,
  ebn0ForBer,
  hopQos,
  performanceFromBlocks,
  qfunc,
  simulatePerformance,
  vigantsOutage,
} from './perf';
import {
  SOUTH_PERU,
  assignSlots,
  circuitsOnTrunk,
  nodeCosts,
  planSummary,
  propagateAlarms,
  radioQos,
  trunkLoad,
} from './network';
import { bitMap, composition, slotTrack } from './bitmap';
import { buildTree } from './tree';
import { E4_SPEC } from './mux';

describe('clocks and slips', () => {
  it('+-50 ppm at each end is about 205 bit/s of difference', () => {
    expect(offsetBps(E1_RATE, 50, -50)).toBeCloseTo(204.8, 6);
  });
  it('a 256-bit frame slips every 1.25 s at 100 ppm of difference', () => {
    expect(slipIntervalSeconds(50, -50)).toBeCloseTo(1.25, 10);
  });
  it('the elastic buffer slips as often as the formula says', () => {
    const run = simulateElasticBuffer({ ppmWrite: 50, ppmRead: -50, seconds: 60, steps: 6000 });
    const expected = 60 / 1.25;
    expect(run.slips.length).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
    expect(run.slips.length).toBeLessThanOrEqual(Math.ceil(expected) + 1);
    expect(run.slips.every((s) => s.direction === 'delete')).toBe(true);
    const slow = simulateElasticBuffer({ ppmWrite: -50, ppmRead: 50, seconds: 10 });
    expect(slow.slips.every((s) => s.direction === 'repeat')).toBe(true);
  });
  it('locked clocks never slip', () => {
    expect(simulateElasticBuffer({ ppmWrite: 3, ppmRead: 3, seconds: 100 }).slips.length).toBe(0);
    expect(slipIntervalSeconds(3, 3)).toBe(Infinity);
  });
  it('wander grows linearly with the offset', () => {
    expect(tieUi(1, 1)).toBeCloseTo(2.048, 9);
  });
  it('waiting-time jitter of a justification pattern is below one unit interval', () => {
    const tree = buildTree({ top: 'E2', e1Ppm: [10, 10, 10, 10] });
    const per: number[] = [];
    for (let i = 0; i < 5200; i++) per.push(tree.nextTopFrame().stuffed[0] ? 205 : 206);
    const steady = per.slice(200); // skip the start-up of the elastic store
    expect(measureWaitingJitterUi(steady)).toBeLessThanOrEqual(1.0001);
    expect(measureWaitingJitterUi(steady)).toBeGreaterThan(0.3);
  });
});

describe('hierarchy', () => {
  it('rates follow G.702', () => {
    expect(HIERARCHY.europe.map((l) => l.kbps)).toEqual([2048, 8448, 34368, 139264, 565148]);
    expect(HIERARCHY.northAmerica.map((l) => l.channels)).toEqual([24, 96, 672, 4032]);
  });
  it('overhead of the European levels is 3.03 / 1.70 / 1.29 %', () => {
    expect(overheadPct('europe', 2)).toBeCloseTo(3.03, 2);
    expect(overheadPct('europe', 3)).toBeCloseTo(1.68, 1);
    expect(overheadPct('europe', 4)).toBeCloseTo(1.29, 1);
  });
  it('dropping one E1 from an E4 takes 3 demultiplexers and 3 multiplexers', () => {
    const c = addDropCost(4, [17]);
    expect(c.pdhDemux).toBe(3);
    expect(c.pdhMux).toBe(3);
    expect(c.pdhUnits).toBe(6);
    expect(c.sdhUnits).toBe(1);
  });
  it('E1 sharing a branch share the equipment', () => {
    const together = addDropCost(4, [0, 1, 2, 3]);
    const apart = addDropCost(4, [0, 16, 32, 48]);
    expect(together.pdhUnits).toBeLessThan(apart.pdhUnits);
    expect(together.pdhDemux).toBe(3);
    expect(apart.pdhDemux).toBe(1 + 4 + 4);
  });
  it('capacities: E2 4, E3 16, E4 64 E1', () => {
    expect(E1_PER_LEVEL).toMatchObject({ 2: 4, 3: 16, 4: 64 });
    expect(FRAME_US[2]).toBeCloseTo(100.38, 2);
  });
});

describe('performance (G.826 style)', () => {
  it('block error probability for a BER', () => {
    expect(blockErrorProbability(1e-6)).toBeCloseTo(2048e-6, 5);
    expect(blockErrorProbability(0)).toBe(0);
  });
  it('Q function and QPSK reference points', () => {
    expect(qfunc(0)).toBeCloseTo(0.5, 6);
    expect(qfunc(4.753)).toBeCloseTo(1e-6, 7);
    expect(berQpsk(ebn0ForBer(1e-6))).toBeCloseTo(1e-6, 8);
    expect(ebn0ForBer(1e-6)).toBeCloseTo(10.53, 1);
  });
  it('Monte Carlo agrees with the closed form', () => {
    const ber = 3e-5;
    const sim = simulatePerformance(ber, 4000, 11);
    const th = analyticPerformance(ber);
    expect(sim.esr).toBeCloseTo(th.esr, 1);
    expect(sim.bber).toBeGreaterThan(th.bber * 0.8);
    expect(sim.bber).toBeLessThan(th.bber * 1.2);
  });
  it('a clean link has no errored seconds', () => {
    const p = simulatePerformance(0, 100);
    expect(p.es + p.ses + p.bbe).toBe(0);
    expect(p.meets.all).toBe(true);
  });
  it('a BER of 1e-3 is severely errored every second and the path becomes unavailable', () => {
    const p = simulatePerformance(1e-3, 100, 3);
    expect(p.uas).toBeGreaterThanOrEqual(90);
    expect(p.meets.all).toBe(false);
  });
  it('unavailability starts after 10 consecutive SES and ends after 10 good seconds', () => {
    const arr = [...Array(20).fill(0), ...Array(12).fill(500), ...Array(5).fill(0), ...Array(3).fill(500), ...Array(30).fill(0)];
    const p = performanceFromBlocks(arr);
    // 12 SES -> unavailable; 5 good + 3 SES do not end it; 30 good -> ends after the first 10
    expect(p.uas).toBe(12 + 5 + 3);
    expect(p.ses).toBe(0);
  });
  it('shorter, higher-margin hops are more available', () => {
    const a = hopQos({ distKm: 40, freqMHz: 7500, fadeMarginDb: 35 });
    const b = hopQos({ distKm: 40, freqMHz: 7500, fadeMarginDb: 25 });
    const c = hopQos({ distKm: 60, freqMHz: 7500, fadeMarginDb: 35 });
    expect(a.availabilityPct).toBeGreaterThan(b.availabilityPct);
    expect(a.availabilityPct).toBeGreaterThan(c.availabilityPct);
    expect(vigantsOutage(40, 7500, 0)).toBe(1);
  });
});

describe('network', () => {
  const t1 = SOUTH_PERU.trunks[0]!;
  it('finds the circuits of a trunk, including those between non adjacent stations', () => {
    const ids = circuitsOnTrunk(SOUTH_PERU, t1).map((d) => d.c.id);
    expect(ids).toEqual(expect.arrayContaining(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']));
    expect(ids).not.toContain('c8');
  });
  it('slots never exceed the capacity of the stream and are unique', () => {
    for (const t of SOUTH_PERU.trunks) {
      for (const s of ['naive', 'optimised'] as const) {
        const { placements, used } = assignSlots(SOUTH_PERU, t, s);
        const all = placements.flatMap((p) => p.slots);
        expect(new Set(all).size).toBe(all.length);
        expect(used).toBeLessThanOrEqual(E1_PER_LEVEL[t.level]!);
      }
    }
  });
  it('the optimised slot plan never costs more equipment than the naive order', () => {
    const naive = planSummary(SOUTH_PERU, 'naive');
    const grouped = planSummary(SOUTH_PERU, 'optimised');
    expect(grouped.pdhUnits).toBeLessThanOrEqual(naive.pdhUnits);
    expect(grouped.sdhUnits).toBe(naive.sdhUnits);
    expect(naive.pdhUnits).toBeGreaterThan(naive.sdhUnits);
  });
  it('overload is detected', () => {
    const big = { ...SOUTH_PERU, circuits: [{ id: 'x', from: 'JUL', to: 'PUN', e1: 40 }] };
    expect(trunkLoad(big, big.trunks[3]!).overloaded).toBe(true);
    expect(trunkLoad(big, big.trunks[3]!).neededLevel).toBe(4);
  });
  it('a cut raises LOS on both sides and AIS beyond', () => {
    const a = propagateAlarms(t1, { trunk: 'T1', link: 1, mode: 'cut' });
    expect(a.links[1]).toEqual({ forward: 'los', backward: 'los' });
    expect(a.links[2]!.forward).toBe('ais');
    expect(a.links[3]!.forward).toBe('ais');
    expect(a.links[0]!.backward).toBe('ais');
    expect(a.nodes[2]!.raised).toContain('LOS');
    expect(a.nodes[1]!.raised).toContain('LOS');
  });
  it('a one-way failure also returns RAI to the sender', () => {
    const a = propagateAlarms(t1, { trunk: 'T1', link: 1, mode: 'forward' });
    expect(a.links[1]).toEqual({ forward: 'los', backward: 'rai' });
    expect(a.nodes[1]!.raised).toContain('RAI');
  });
  it('no fault, no alarms', () => {
    const a = propagateAlarms(t1, null);
    expect(a.links.every((l) => l.forward === 'ok' && l.backward === 'ok')).toBe(true);
  });
  it('radio trunks get a quality figure, fibre ones do not', () => {
    expect(radioQos(SOUTH_PERU, SOUTH_PERU.trunks[0]!)).toBeNull();
    const q = radioQos(SOUTH_PERU, SOUTH_PERU.trunks[4]!)!;
    expect(q.hops.length).toBe(3);
    expect(q.total.availabilityPct).toBeLessThan(100);
    expect(q.total.availabilityPct).toBeGreaterThan(99);
  });
  it('end stations of a trunk also pay for the dropped circuits', () => {
    const costs = nodeCosts(SOUTH_PERU, t1, 'naive');
    expect(costs[0]!.droppedE1).toBeGreaterThan(0);
    expect(costs.reduce((a, c) => a + c.droppedE1, 0)).toBe(2 * circuitsOnTrunk(SOUTH_PERU, t1).reduce((a, d) => a + d.c.e1, 0));
  });
});

describe('bit map', () => {
  it('classifies every bit of an E4 frame and traces data to its E1', () => {
    const tree = buildTree({ top: 'E4', e1Ppm: Array(64).fill(5) });
    for (let i = 0; i < 3; i++) tree.nextTopFrame();
    const frame = tree.nextTopFrame();
    const cells = bitMap(E4_SPEC, frame.symbols);
    expect(cells.length).toBe(2928);
    const c = composition(cells);
    expect(c.fas).toBe(12);
    expect(c.cj).toBe(20);
    const traced = cells.filter((x) => x.origin);
    expect(traced.length).toBeGreaterThan(2500);
    expect(traced.every((x) => x.path!.e3 === x.trib)).toBe(true);
  });
  it('the position of an E1 time slot moves inside the E4 from frame to frame', () => {
    const tree = buildTree({ top: 'E4', e1Ppm: Array(64).fill(10) });
    const frames = Array.from({ length: 200 }, () => tree.nextTopFrame().symbols);
    const track = slotTrack(frames, 3, 0).filter((x): x is number => x !== null);
    expect(track.length).toBeGreaterThan(5);
    expect(new Set(track).size).toBeGreaterThan(2);
  });
});
