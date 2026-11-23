/**
 * A PDH transport network: stations, trunks (chains of links that share one stream), the E1
 * circuits they carry, the cost of dropping circuits at the intermediate stations and the way
 * alarms travel when a link fails.
 */
import { addDropCost, E1_PER_LEVEL, type AddDropCost } from './hierarchy';
import { hopQos, seriesQos, type HopQos } from './perf';

export interface Station {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface RadioSpec {
  freqMHz: number;
  fadeMarginDb: number;
  /** Number of equal hops the link is split into (repeaters in between). */
  hops: number;
  terrainFactor: number;
}

export interface Trunk {
  id: string;
  name: string;
  /** Stream level carried over the whole chain: 2 = E2, 3 = E3, 4 = E4. */
  level: 2 | 3 | 4;
  /** Stations in order. */
  path: string[];
  medium: 'fiber' | 'radio';
  radio?: RadioSpec;
}

export interface Circuit {
  id: string;
  from: string;
  to: string;
  /** Number of E1 of the demand. */
  e1: number;
}

export interface Network {
  stations: Station[];
  trunks: Trunk[];
  circuits: Circuit[];
}

export const LEVEL_NAME = { 2: 'E2', 3: 'E3', 4: 'E4' } as const;
export const capacity = (level: 2 | 3 | 4): number => E1_PER_LEVEL[level]!;

const R = 6371;
export function distanceKm(a: Station, b: Station): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function stationOf(net: Network, id: string): Station {
  const s = net.stations.find((x) => x.id === id);
  if (!s) throw new Error(`unknown station ${id}`);
  return s;
}

export function trunkLengthKm(net: Network, t: Trunk): number {
  let km = 0;
  for (let i = 0; i + 1 < t.path.length; i++) km += distanceKm(stationOf(net, t.path[i]!), stationOf(net, t.path[i + 1]!));
  return km;
}

export interface Placement {
  circuit: Circuit;
  trunk: Trunk;
  /** Positions in the trunk path of the two ends. */
  a: number;
  b: number;
  /** First E1 slot in the stream and how many E1. */
  slots: number[];
}

export type Strategy = 'naive' | 'optimised';

/** The circuits whose both ends lie on the trunk, in the order they were requested. */
export function circuitsOnTrunk(net: Network, t: Trunk): { c: Circuit; a: number; b: number }[] {
  const out: { c: Circuit; a: number; b: number }[] = [];
  for (const c of net.circuits) {
    const i = t.path.indexOf(c.from);
    const j = t.path.indexOf(c.to);
    if (i < 0 || j < 0 || i === j) continue;
    out.push({ c, a: Math.min(i, j), b: Math.max(i, j) });
  }
  return out;
}

type Demand = ReturnType<typeof circuitsOnTrunk>[number];

function allocate(demands: Demand[], t: Trunk, align: number): { placements: Placement[]; used: number; overflow: number } {
  const cap = capacity(t.level);
  let next = 0;
  let overflow = 0;
  const placements: Placement[] = [];
  for (const d of demands) {
    // start on a branch boundary when there is room, so the circuit does not straddle two branches
    const aligned = Math.ceil(next / align) * align;
    if (align > 1 && aligned + d.c.e1 <= cap) next = aligned;
    const slots: number[] = [];
    for (let k = 0; k < d.c.e1; k++) {
      if (next < cap) slots.push(next++);
      else overflow++;
    }
    placements.push({ circuit: d.c, trunk: t, a: d.a, b: d.b, slots });
  }
  return { placements, used: next, overflow };
}

function placementUnits(t: Trunk, placements: Placement[]): number {
  let units = 0;
  for (let idx = 0; idx < t.path.length; idx++) {
    const slots: number[] = [];
    for (const p of placements) if (p.a === idx || p.b === idx) slots.push(...p.slots);
    units += addDropCost(t.level, slots).pdhUnits;
  }
  return units;
}

/**
 * Hand out E1 slots of a trunk.
 * - naive: in the order the demands arrived, one after another.
 * - optimised: tries several orders (by first station, by last station, longest first, as
 *   requested) with and without alignment to the E2/E3 branches, and keeps the one that
 *   needs the least multiplexing equipment. It can never be worse than naive.
 */
export function assignSlots(net: Network, t: Trunk, strategy: Strategy): { placements: Placement[]; used: number; overflow: number } {
  const demands = circuitsOnTrunk(net, t);
  if (strategy === 'naive') return allocate(demands, t, 1);
  const orders: Demand[][] = [
    demands,
    [...demands].sort((x, y) => x.a - y.a || x.b - y.b),
    [...demands].sort((x, y) => x.b - y.b || x.a - y.a),
    [...demands].sort((x, y) => y.b - y.a - (x.b - x.a) || x.a - y.a),
  ];
  let best = allocate(demands, t, 1);
  let bestUnits = placementUnits(t, best.placements);
  for (const order of orders) {
    for (const align of [1, 4, 16]) {
      const cand = allocate(order, t, align);
      if (cand.overflow > best.overflow) continue;
      const u = placementUnits(t, cand.placements);
      if (cand.overflow < best.overflow || u < bestUnits) {
        best = cand;
        bestUnits = u;
      }
    }
  }
  return best;
}

export interface NodeCost {
  station: string;
  trunk: string;
  droppedE1: number;
  cost: AddDropCost;
}

/** Equipment needed at every intermediate station of a trunk, and at its ends. */
export function nodeCosts(net: Network, t: Trunk, strategy: Strategy): NodeCost[] {
  const { placements } = assignSlots(net, t, strategy);
  return t.path.map((id, idx) => {
    const slots: number[] = [];
    for (const p of placements) if (p.a === idx || p.b === idx) slots.push(...p.slots);
    return { station: id, trunk: t.id, droppedE1: slots.length, cost: addDropCost(t.level, slots) };
  });
}

export interface PlanSummary {
  pdhUnits: number;
  sdhUnits: number;
  pdhDelayUs: number;
  nodes: NodeCost[];
}

export function planSummary(net: Network, strategy: Strategy): PlanSummary {
  const nodes = net.trunks.flatMap((t) => nodeCosts(net, t, strategy));
  return {
    pdhUnits: nodes.reduce((a, n) => a + n.cost.pdhUnits, 0),
    sdhUnits: nodes.reduce((a, n) => a + n.cost.sdhUnits, 0),
    pdhDelayUs: nodes.reduce((a, n) => a + n.cost.pdhDelayUs, 0),
    nodes,
  };
}

export interface TrunkLoad {
  trunk: Trunk;
  demandE1: number;
  capacityE1: number;
  /** Smallest stream level that would carry the demand, or null when even E4 is too small. */
  neededLevel: 2 | 3 | 4 | null;
  overloaded: boolean;
}

export function trunkLoad(net: Network, t: Trunk): TrunkLoad {
  const demand = circuitsOnTrunk(net, t).reduce((a, d) => a + d.c.e1, 0);
  const needed = ([2, 3, 4] as const).find((l) => capacity(l) >= demand) ?? null;
  return { trunk: t, demandE1: demand, capacityE1: capacity(t.level), neededLevel: needed, overloaded: demand > capacity(t.level) };
}

/** Quality of a radio trunk: one figure per hop and the series result. */
export function radioQos(net: Network, t: Trunk): { hops: HopQos[]; total: ReturnType<typeof seriesQos>; hopKm: number } | null {
  if (t.medium !== 'radio' || !t.radio) return null;
  const km = trunkLengthKm(net, t) / t.radio.hops;
  const one = hopQos({ distKm: km, freqMHz: t.radio.freqMHz, fadeMarginDb: t.radio.fadeMarginDb, terrainFactor: t.radio.terrainFactor });
  const hops = Array.from({ length: t.radio.hops }, () => one);
  return { hops, total: seriesQos(hops), hopKm: km };
}

/* ------------------------------------------------------------------ alarms */

export type Signal = 'ok' | 'los' | 'ais' | 'rai';
export type FaultMode = 'cut' | 'forward' | 'backward';

export interface Fault {
  trunk: string;
  /** Link index inside the trunk path: the link between path[link] and path[link + 1]. */
  link: number;
  mode: FaultMode;
}

export interface LinkSignals {
  /** What travels along the link in the forward direction (path[i] -> path[i+1]) and backward. */
  forward: Signal;
  backward: Signal;
}

export interface NodeAlarms {
  station: string;
  /** Alarms raised at this station, e.g. LOS from the left, AIS received, RAI received. */
  raised: string[];
}

export interface AlarmState {
  links: LinkSignals[];
  nodes: NodeAlarms[];
}

/**
 * Propagate alarms along a trunk after a failure:
 * - the station after a dead link sees LOS, and sends AIS onwards in the same direction,
 * - it also sends RAI back towards the source, if that direction still works.
 */
export function propagateAlarms(t: Trunk, fault: Fault | null): AlarmState {
  const n = t.path.length;
  const links: LinkSignals[] = Array.from({ length: n - 1 }, () => ({ forward: 'ok', backward: 'ok' }));
  const nodes: NodeAlarms[] = t.path.map((station) => ({ station, raised: [] }));
  if (!fault || fault.trunk !== t.id || fault.link < 0 || fault.link >= n - 1) return { links, nodes };

  const k = fault.link;
  const fwdDead = fault.mode === 'cut' || fault.mode === 'forward';
  const bwdDead = fault.mode === 'cut' || fault.mode === 'backward';

  if (fwdDead) {
    links[k]!.forward = 'los';
    nodes[k + 1]!.raised.push('LOS');
    for (let i = k + 1; i < n - 1; i++) links[i]!.forward = 'ais';
    for (let i = k + 2; i < n; i++) nodes[i]!.raised.push('AIS');
    if (!bwdDead) {
      links[k]!.backward = 'rai';
      nodes[k]!.raised.push('RAI');
    }
  }
  if (bwdDead) {
    links[k]!.backward = 'los';
    nodes[k]!.raised.push('LOS');
    for (let i = k - 1; i >= 0; i--) links[i]!.backward = 'ais';
    for (let i = k - 1; i >= 0; i--) nodes[i]!.raised.push('AIS');
    if (!fwdDead) {
      links[k]!.forward = 'rai';
      nodes[k + 1]!.raised.push('RAI');
    }
  }
  return { links, nodes };
}

/* --------------------------------------------------------------- sample data */

export const SOUTH_PERU: Network = {
  stations: [
    { id: 'TAC', name: 'Tacna', lat: -18.0066, lng: -70.2463 },
    { id: 'ILO', name: 'Ilo', lat: -17.6394, lng: -71.3378 },
    { id: 'MOQ', name: 'Moquegua', lat: -17.1956, lng: -70.9357 },
    { id: 'MOL', name: 'Mollendo', lat: -17.0233, lng: -72.0147 },
    { id: 'CAM', name: 'Camaná', lat: -16.6236, lng: -72.7111 },
    { id: 'AQP', name: 'Arequipa', lat: -16.409, lng: -71.5375 },
    { id: 'CHI', name: 'Chivay', lat: -15.6376, lng: -71.6019 },
    { id: 'JUL', name: 'Juliaca', lat: -15.4997, lng: -70.1333 },
    { id: 'PUN', name: 'Puno', lat: -15.8402, lng: -70.0219 },
    { id: 'CUS', name: 'Cusco', lat: -13.5319, lng: -71.9675 },
  ],
  trunks: [
    { id: 'T1', name: 'Troncal Sur', level: 4, path: ['TAC', 'MOQ', 'AQP', 'JUL', 'CUS'], medium: 'fiber' },
    { id: 'T2', name: 'Costa Ilo', level: 3, path: ['MOQ', 'ILO'], medium: 'fiber' },
    { id: 'T3', name: 'Costa Mollendo', level: 3, path: ['AQP', 'MOL'], medium: 'fiber' },
    {
      id: 'T4',
      name: 'Radio Altiplano',
      level: 3,
      path: ['JUL', 'PUN'],
      medium: 'radio',
      radio: { freqMHz: 7500, fadeMarginDb: 38, hops: 1, terrainFactor: 1 },
    },
    {
      id: 'T5',
      name: 'Radio Colca',
      level: 2,
      path: ['AQP', 'CHI'],
      medium: 'radio',
      radio: { freqMHz: 7500, fadeMarginDb: 36, hops: 3, terrainFactor: 0.25 },
    },
    {
      id: 'T6',
      name: 'Radio Camaná',
      level: 2,
      path: ['AQP', 'CAM'],
      medium: 'radio',
      radio: { freqMHz: 7500, fadeMarginDb: 36, hops: 3, terrainFactor: 0.25 },
    },
  ],
  circuits: [
    { id: 'c1', from: 'TAC', to: 'AQP', e1: 9 },
    { id: 'c2', from: 'MOQ', to: 'JUL', e1: 3 },
    { id: 'c3', from: 'AQP', to: 'CUS', e1: 12 },
    { id: 'c4', from: 'TAC', to: 'MOQ', e1: 4 },
    { id: 'c5', from: 'AQP', to: 'JUL', e1: 8 },
    { id: 'c6', from: 'JUL', to: 'CUS', e1: 5 },
    { id: 'c7', from: 'TAC', to: 'CUS', e1: 2 },
    { id: 'c8', from: 'MOQ', to: 'ILO', e1: 6 },
    { id: 'c9', from: 'AQP', to: 'MOL', e1: 7 },
    { id: 'c10', from: 'JUL', to: 'PUN', e1: 10 },
    { id: 'c11', from: 'AQP', to: 'CHI', e1: 3 },
    { id: 'c12', from: 'AQP', to: 'CAM', e1: 2 },
  ],
};
