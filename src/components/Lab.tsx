import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { bitMap, composition, slotTrack, type Cell } from '../core/bitmap';
import { measureWaitingJitterUi } from '../core/clock';
import type { Sym } from '../core/bits';
import { E2_SPEC, E3_SPEC, E4_SPEC, nominalStuffRatio, type MuxSpec } from '../core/mux';
import { buildTree, demuxTree, E1_COUNT, injectErrors, type E1Content, type TopLevel } from '../core/tree';
import { useI18n } from '../i18n';
import { BitMap, cellColor, e1Color, KIND_COLOR, TRIB_COLOR, type ColorMode } from './BitMap';
import { Badge, Card, Legend, LineChart, Segmented, Slider, Stat, Toggle } from './ui';

const SPECS: Record<TopLevel, MuxSpec> = { E2: E2_SPEC, E3: E3_SPEC, E4: E4_SPEC };
const VIEW: Record<TopLevel, { cols: number; setRows: number; frames: number }> = {
  E2: { cols: 53, setRows: 4, frames: 900 },
  E3: { cols: 64, setRows: 6, frames: 600 },
  E4: { cols: 61, setRows: 8, frames: 500 },
};

type Preset = 'nominal' | 'spread' | 'extremes';

export interface LabParams {
  top: TopLevel;
  preset: Preset;
  selE1: number;
  selPpm: number | null;
  e2Ppm: number;
  e3Ppm: number;
  e4Ppm: number;
  berExp: number; // 0 = off, otherwise BER = 10^-berExp
  content: E1Content;
  crc4: boolean;
}

export const DEFAULT_LAB: LabParams = {
  top: 'E4',
  preset: 'spread',
  selE1: 5,
  selPpm: null,
  e2Ppm: 0,
  e3Ppm: 0,
  e4Ppm: 0,
  berExp: 0,
  content: 'tone',
  crc4: true,
};

function presetPpm(preset: Preset, i: number): number {
  if (preset === 'nominal') return 0;
  if (preset === 'extremes') return i % 2 ? 50 : -50;
  return ((i * 37) % 101) - 50;
}

export function e1PpmList(p: LabParams): number[] {
  return Array.from({ length: E1_COUNT[p.top] }, (_, i) => (i === p.selE1 && p.selPpm !== null ? p.selPpm : presetPpm(p.preset, i)));
}

interface LevelReport {
  name: string;
  spec: MuxSpec;
  measured: number;
  theory: number;
  /** Largest gap between measured and theoretical ratio over all multiplexers and tributaries. */
  worst: number;
  frames: number;
}

interface Sim {
  clean: Sym[][];
  received: Sym[][];
  errors: Set<number>[];
  levels: LevelReport[];
  recovery: { ok: number; total: number; badBits: number; checkedBits: number; perE1: boolean[] };
  jitterUi: number;
  injected: number;
}

function theoryRatio(spec: MuxSpec, tribPpm: number, linePpm: number): number {
  const bpf = (spec.tribRate * (1 + tribPpm * 1e-6) * spec.frameBits) / (spec.lineRate * (1 + linePpm * 1e-6));
  return Math.min(1, Math.max(0, spec.dataPerTrib + 1 - bpf));
}

function simulate(p: LabParams): Sim {
  const n = VIEW[p.top].frames;
  const e1Ppm = e1PpmList(p);
  const e2 = Array.from({ length: 16 }, () => p.e2Ppm);
  const e3 = Array.from({ length: 4 }, () => p.e3Ppm);
  const tree = buildTree({
    top: p.top,
    e1Ppm,
    e2Ppm: e2,
    e3Ppm: e3,
    e4Ppm: p.e4Ppm,
    e1: { content: p.content, crc4: p.crc4, cas: false },
    record: { mux: p.selE1 >> 2, trib: p.selE1 & 3 },
  });
  const clean: Sym[][] = [];
  for (let i = 0; i < n; i++) clean.push(tree.nextTopFrame().symbols);
  const received = clean.map((f) => f.slice());
  const ber = p.berExp > 0 ? 10 ** -p.berExp : 0;
  const injected = injectErrors(received, ber, 20260101);
  const errors = clean.map((f, k) => {
    const s = new Set<number>();
    const r = received[k]!;
    for (let i = 0; i < f.length; i++) if (f[i] !== r[i]) s.add(i);
    return s;
  });

  // level reports: measured vs theory of the stuffing ratio
  const levels: LevelReport[] = [];
  const nE2 = E1_COUNT[p.top] / 4;
  const addLevel = (name: string, sp: MuxSpec, frames: number, rows: number[][], tribPpm: (m: number, t: number) => number, linePpm: (m: number) => number) => {
    if (frames === 0) return;
    let sm = 0;
    let st = 0;
    let c = 0;
    let worst = 0;
    rows.forEach((row, m) =>
      row.forEach((count, t) => {
        const meas = count / frames;
        const th = theoryRatio(sp, tribPpm(m, t), linePpm(m));
        sm += meas;
        st += th;
        c++;
        worst = Math.max(worst, Math.abs(meas - th));
      }),
    );
    levels.push({ name, spec: sp, measured: sm / c, theory: st / c, worst, frames });
  };
  addLevel('E2', E2_SPEC, tree.stats.E2.frames, tree.stats.E2.stuffed.slice(0, nE2), (m, t) => e1Ppm[m * 4 + t]!, (m) => e2[m]!);
  if (p.top !== 'E2') {
    addLevel('E3', E3_SPEC, tree.stats.E3.frames, tree.stats.E3.stuffed, (m, t) => e2[m * 4 + t]!, (m) => e3[m]!);
  }
  if (p.top === 'E4') addLevel('E4', E4_SPEC, tree.stats.E4.frames, tree.stats.E4.stuffed, (_m, t) => e3[t]!, () => p.e4Ppm);

  // full demultiplexing and bit-by-bit comparison with the E1 that were sent
  const out = demuxTree(p.top, received);
  const ref = buildTree({ top: p.top, e1: { content: p.content, crc4: p.crc4, cas: false } });
  let ok = 0;
  let bad = 0;
  let checked = 0;
  const perE1: boolean[] = [];
  out.forEach((stream, i) => {
    const expected = ref.e1[i]!.pull(stream.length);
    let wrong = 0;
    for (let k = 0; k < stream.length; k++) if (stream[k] !== expected[k]) wrong++;
    perE1.push(wrong === 0);
    if (wrong === 0) ok++;
    bad += wrong;
    checked += stream.length;
  });

  const per = tree.pattern.map((s) => (s ? E2_SPEC.dataPerTrib : E2_SPEC.dataPerTrib + 1));
  const jitterUi = measureWaitingJitterUi(per.slice(Math.min(200, Math.floor(per.length / 4))));
  return {
    clean,
    received,
    errors,
    levels,
    recovery: { ok, total: out.length, badBits: bad, checkedBits: checked, perE1 },
    jitterUi,
    injected,
  };
}

function describe(c: Cell, spec: MuxSpec, tr: (es: string, en: string) => string): { title: string; body: string } {
  const nSets = spec.id === 'E4' ? 6 : 4;
  const set = Math.floor(c.index / (spec.frameBits / nSets)) + 1;
  const where = tr(`Bit ${c.index + 1} de ${spec.frameBits} · bloque ${set}`, `Bit ${c.index + 1} of ${spec.frameBits} · set ${set}`);
  switch (c.kind) {
    case 'fas':
      return {
        title: tr('FAS: alineación de trama', 'FAS: frame alignment'),
        body: tr(
          `${where}. Bit ${c.idx + 1} de la palabra de alineación ${spec.fas.join('')}: el demultiplexor la busca para saber dónde empieza la trama.`,
          `${where}. Bit ${c.idx + 1} of the alignment word ${spec.fas.join('')}: the demultiplexer hunts for it to know where the frame starts.`,
        ),
      };
    case 'alarm':
      return { title: tr('A: alarma al extremo remoto', 'A: remote alarm'), body: `${where}. ${tr('0 = normal, 1 = fallo del sentido contrario.', '0 = normal, 1 = failure in the opposite direction.')}` };
    case 'national':
      return { title: tr('Uso nacional', 'National use'), body: `${where}. ${tr('Reservado a cada administración; aquí fijo en 1.', 'Reserved for each administration; fixed to 1 here.')}` };
    case 'reserved':
      return { title: tr('Reservado', 'Reserved'), body: `${where}. ${tr('Reservado a uso internacional; aquí fijo en 1.', 'Reserved for international use; fixed to 1 here.')}` };
    case 'cj':
      return {
        title: `Cj${c.idx + 1} · ${tr('afluente', 'tributary')} ${c.trib + 1}`,
        body: tr(
          `${where}. Bit de control de justificación ${c.idx + 1} de ${spec.cjBits}. El receptor decide por mayoría (${(spec.cjBits + 1) / 2} de ${spec.cjBits}): ${c.bit ? 'este bit vota "relleno"' : 'este bit vota "dato"'}.`,
          `${where}. Justification control bit ${c.idx + 1} of ${spec.cjBits}. The receiver decides by majority (${(spec.cjBits + 1) / 2} of ${spec.cjBits}): ${c.bit ? 'this bit votes "stuffing"' : 'this bit votes "data"'}.`,
        ),
      };
    case 'stuff':
      return {
        title: `S · ${tr('afluente', 'tributary')} ${c.trib + 1}`,
        body: tr(
          `${where}. Oportunidad de justificación: en esta trama es RELLENO (se descarta en el receptor). Es lo que absorbe la diferencia de reloj.`,
          `${where}. Justification opportunity: in this frame it is STUFFING (discarded by the receiver). This is what absorbs the clock difference.`,
        ),
      };
    default: {
      if (c.carriedInS && c.origin) {
        return {
          title: tr('S llevando un dato', 'S carrying data'),
          body: tr(
            `${where}. En esta trama el afluente ${c.trib + 1} iba adelantado y el bit S transporta un bit real del E1 ${c.origin.src + 1}.`,
            `${where}. In this frame tributary ${c.trib + 1} was ahead and the S bit carries a real bit of E1 ${c.origin.src + 1}.`,
          ),
        };
      }
      if (c.lowerOverhead) {
        return {
          title: tr('Cabecera de un nivel inferior', 'Overhead of a lower level'),
          body: tr(
            `${where}. Este bit lo generó un multiplexor de nivel inferior (FAS, Cj o relleno de E2/E3) y viaja aquí como si fuera carga: por eso PDH no puede ver dentro sin demultiplexar.`,
            `${where}. A lower-level multiplexer generated this bit (FAS, Cj or stuffing of E2/E3) and it travels here as payload: that is why PDH cannot look inside without demultiplexing.`,
          ),
        };
      }
      const o = c.origin;
      if (!o) return { title: tr('Dato', 'Data'), body: where };
      const tail = tr(
        `Es el bit ${o.bitInTs} del intervalo TS${o.ts} de la trama E1 nº ${o.frame}.`,
        `It is bit ${o.bitInTs} of time slot TS${o.ts} of E1 frame no. ${o.frame}.`,
      );
      return {
        title: `E1 ${o.src + 1} · TS${o.ts}`,
        body: `${where}. ${tr('Camino', 'Path')}: E3 ${c.path!.e3 + 1} → E2 ${c.path!.e2 + 1} → E1 ${c.path!.e1 + 1}. ${tail}`,
      };
    }
  }
}

export function Lab({ params, setParams, dark }: { params: LabParams; setParams: (p: LabParams) => void; dark: boolean }) {
  const { tr, num } = useI18n();
  const [mode, setMode] = useState<ColorMode>('kind');
  const [frame, setFrame] = useState(20);
  const [play, setPlay] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [ts, setTs] = useState(1);
  const [highlight, setHighlight] = useState(false);

  const deferred = useDeferredValue(params);
  const pending = deferred !== params;
  const sim = useMemo(() => simulate(deferred), [deferred]);
  const spec = SPECS[params.top];
  const view = VIEW[params.top];
  const frameIdx = Math.min(frame, sim.clean.length - 1);

  useEffect(() => {
    if (!play) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % sim.clean.length), 220);
    return () => clearInterval(id);
  }, [play, sim.clean.length]);

  const cells = useMemo(() => bitMap(spec, sim.received[frameIdx]!), [spec, sim, frameIdx]);
  const comp = useMemo(() => composition(cells), [cells]);
  const shown = hover ?? pinned;
  const cell = shown !== null ? cells[shown] : undefined;
  const info = cell ? describe(cell, spec, tr) : null;

  const set = (patch: Partial<LabParams>) => setParams({ ...params, ...patch });
  const nE1 = E1_COUNT[params.top];
  const ber = params.berExp > 0 ? 10 ** -params.berExp : 0;

  const track = useMemo(
    () => (params.top === 'E4' || params.top === 'E3' || params.top === 'E2' ? slotTrack(sim.clean, params.selE1, ts) : []),
    [sim, params.selE1, params.top, ts],
  );
  const trackPoints: [number, number][] = track.flatMap((p, i) => (p === null ? [] : [[i, p] as [number, number]]));

  const recoveredAll = sim.recovery.ok === sim.recovery.total;
  const overheadPct = ((comp.fas + comp.alarm + comp.national + comp.reserved + comp.cj + comp.stuff) / spec.frameBits) * 100;

  return (
    <div className={`tab-grid ${pending ? 'pending' : ''}`} aria-busy={pending}>
      <aside className="sidebar" aria-label={tr('Controles del laboratorio', 'Lab controls')}>
        <Card title={tr('Jerarquía', 'Hierarchy')}>
          <div className="stack">
            <div className="field">
              <span className="label">{tr('Nivel superior', 'Top level')}</span>
              <Segmented
                label={tr('Nivel superior', 'Top level')}
                value={params.top}
                onChange={(top) => set({ top, selE1: Math.min(params.selE1, E1_COUNT[top] - 1) })}
                options={[
                  { value: 'E2', label: 'E2 · 4×E1' },
                  { value: 'E3', label: 'E3 · 16×E1' },
                  { value: 'E4', label: 'E4 · 64×E1' },
                ]}
              />
            </div>
            <div className="field">
              <span className="label">{tr('Tráfico de cada E1', 'Traffic on every E1')}</span>
              <Segmented
                label={tr('Tráfico', 'Traffic')}
                value={params.content}
                onChange={(content) => set({ content })}
                options={[
                  { value: 'tone', label: tr('Voz (tonos)', 'Voice (tones)') },
                  { value: 'prbs', label: 'PRBS-15' },
                  { value: 'idle', label: tr('Silencio', 'Idle') },
                ]}
              />
            </div>
            <Toggle label={tr('CRC-4 en cada E1 (G.704)', 'CRC-4 on every E1 (G.704)')} checked={params.crc4} onChange={(crc4) => set({ crc4 })} />
          </div>
        </Card>

        <Card title={tr('Relojes (ppm)', 'Clocks (ppm)')}>
          <div className="stack">
            <div className="field">
              <span className="label">{tr('Reloj de los E1', 'E1 clocks')}</span>
              <Segmented
                label={tr('Reloj de los E1', 'E1 clocks')}
                value={params.preset}
                onChange={(preset) => set({ preset })}
                options={[
                  { value: 'nominal', label: tr('Nominal', 'Nominal') },
                  { value: 'spread', label: tr('Dispersos', 'Spread') },
                  { value: 'extremes', label: '±50' },
                ]}
              />
              <span className="hint">{tr('Cada E1 tiene su propio reloj: eso es lo "plesiócrono".', 'Every E1 has its own clock: that is what "plesiochronous" means.')}</span>
            </div>
            <div className="field">
              <label htmlFor="selE1">{tr('E1 observado', 'Observed E1')}</label>
              <select id="selE1" value={params.selE1} onChange={(e) => set({ selE1: Number(e.target.value) })}>
                {Array.from({ length: nE1 }, (_, i) => (
                  <option key={i} value={i}>
                    E1 {i + 1} · {num(e1PpmList(params)[i]!, 0)} ppm
                  </option>
                ))}
              </select>
            </div>
            <Slider
              label={tr('Reloj del E1 observado', 'Observed E1 clock')}
              value={params.selPpm ?? e1PpmList({ ...params, selPpm: null })[params.selE1]!}
              min={-50}
              max={50}
              unit="ppm"
              onChange={(v) => set({ selPpm: v })}
              hint={tr('G.703 admite ±50 ppm en un E1.', 'G.703 allows ±50 ppm on an E1.')}
            />
            <Slider label={tr('Multiplexores 2/8', '2/8 multiplexers')} value={params.e2Ppm} min={-30} max={30} unit="ppm" onChange={(e2Ppm) => set({ e2Ppm })} hint={tr('Tolerancia E2: ±30 ppm', 'E2 tolerance: ±30 ppm')} />
            {params.top !== 'E2' && (
              <Slider label={tr('Multiplexores 8/34', '8/34 multiplexers')} value={params.e3Ppm} min={-20} max={20} unit="ppm" onChange={(e3Ppm) => set({ e3Ppm })} hint={tr('Tolerancia E3: ±20 ppm', 'E3 tolerance: ±20 ppm')} />
            )}
            {params.top === 'E4' && (
              <Slider label={tr('Multiplexor 34/140', '34/140 multiplexer')} value={params.e4Ppm} min={-15} max={15} unit="ppm" onChange={(e4Ppm) => set({ e4Ppm })} hint={tr('Tolerancia E4: ±15 ppm', 'E4 tolerance: ±15 ppm')} />
            )}
          </div>
        </Card>

        <Card title={tr('Línea', 'Line')}>
          <Slider
            label={tr('Tasa de error de la línea (BER)', 'Line bit error ratio (BER)')}
            value={params.berExp}
            min={0}
            max={6}
            format={(v) => (v === 0 ? tr('sin errores', 'error-free') : `10⁻${v}`)}
            onChange={(berExp) => set({ berExp })}
            hint={tr('Voltea bits al azar en la línea de orden superior. Mira cómo la votación de Cj los corrige… o no.', 'Flips random bits on the high-order line. Watch the Cj vote correct them… or not.')}
          />
        </Card>
      </aside>

      <main className="stage-col">
        <Card
          title={tr(`Mapa de bits de la trama ${params.top}`, `${params.top} frame bit map`)}
          aside={
            <div className="row">
              <Segmented
                label={tr('Color', 'Colour')}
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'kind', label: tr('Tipo', 'Type') },
                  { value: 'trib', label: tr('Afluente', 'Tributary') },
                  { value: 'e1', label: 'E1' },
                ]}
              />
            </div>
          }
        >
          <div className="bitmap-grid">
            <div>
              <BitMap
                cells={cells}
                cols={view.cols}
                setRows={view.setRows}
                mode={mode}
                selectedE1={highlight ? params.selE1 : null}
                errors={sim.errors[frameIdx]}
                pinned={pinned}
                onPick={(i) => setPinned(i === pinned ? null : i)}
                onHover={setHover}
                dark={dark}
                label={tr(
                  `Trama ${params.top} de ${spec.frameBits} bits, un cuadro por bit`,
                  `${params.top} frame of ${spec.frameBits} bits, one square per bit`,
                )}
              />
              <div className="frame-nav">
                <button type="button" className="btn btn-small" onClick={() => setPlay(!play)} aria-pressed={play}>
                  {play ? '⏸' : '▶'} {play ? tr('Pausa', 'Pause') : tr('Reproducir', 'Play')}
                </button>
                <input
                  type="range"
                  min={0}
                  max={sim.clean.length - 1}
                  value={frameIdx}
                  onChange={(e) => setFrame(Number(e.target.value))}
                  aria-label={tr('Número de trama', 'Frame number')}
                />
                <output>
                  {tr('trama', 'frame')} {frameIdx + 1}/{sim.clean.length}
                </output>
              </div>
              <Legend
                items={
                  mode === 'kind'
                    ? [
                        { name: 'FAS', color: KIND_COLOR.fas },
                        { name: tr('A / nacional / reservado', 'A / national / reserved'), color: KIND_COLOR.alarm },
                        { name: 'Cj', color: KIND_COLOR.cj },
                        { name: tr('S: relleno', 'S: stuffing'), color: KIND_COLOR.stuff },
                        { name: tr('S: dato', 'S: data'), color: '#22c55e' },
                        { name: tr('Dato de un E1', 'E1 data'), color: KIND_COLOR.data },
                        { name: tr('Cabecera de nivel inferior', 'Lower-level overhead'), color: '#64748b' },
                      ]
                    : mode === 'trib'
                      ? TRIB_COLOR.map((c, i) => ({ name: `${tr('Afluente', 'Tributary')} ${i + 1}`, color: c }))
                      : [{ name: tr('Un color por E1 de origen (64 tonos)', 'One colour per source E1 (64 hues)'), color: e1Color(5) }]
                }
              />
              <p className="hint">
                {tr('Sólido = bit 1, tenue = bit 0. Línea punteada: separa los bloques de justificación. Borde rojo: bit volteado por la línea.', 'Solid = bit 1, faded = bit 0. Dashed line: splits the justification sets. Red border: bit flipped by the line.')}
              </p>
            </div>

            <div className="inspector" aria-live="polite">
              <h3>{tr('Inspector', 'Inspector')}</h3>
              {info && cell ? (
                <>
                  <div className="inspector-head">
                    <span className="swatch big" style={{ background: cellColor(cell, mode === 'kind' ? 'e1' : mode) }} aria-hidden="true" />
                    <div>
                      <strong>{info.title}</strong>
                      <div className="hint">
                        {tr('valor', 'value')}: <code>{cell.bit}</code>
                        {sim.errors[frameIdx]?.has(cell.index) && <span className="err"> · {tr('¡volteado por la línea!', 'flipped by the line!')}</span>}
                      </div>
                    </div>
                  </div>
                  <p>{info.body}</p>
                  {cell.origin && (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        set({ selE1: cell.origin!.src });
                        setHighlight(true);
                      }}
                    >
                      {tr(`Seguir al E1 ${cell.origin.src + 1}`, `Follow E1 ${cell.origin.src + 1}`)}
                    </button>
                  )}
                </>
              ) : (
                <p className="hint">{tr('Pasa el cursor por un bit, o haz clic para fijarlo. Los bits de datos se rastrean hasta el E1, el intervalo y la muestra que los originó.', 'Hover a bit, or click to pin it. Data bits are traced back to the E1, time slot and sample that produced them.')}</p>
              )}
              <Toggle label={tr(`Resaltar el E1 ${params.selE1 + 1}`, `Highlight E1 ${params.selE1 + 1}`)} checked={highlight} onChange={setHighlight} />
              <dl className="composition">
                <dt>{tr('Cabecera + justificación', 'Overhead + justification')}</dt>
                <dd>{num(overheadPct, 2)} %</dd>
                <dt>FAS / Cj / S</dt>
                <dd>
                  {comp.fas} / {comp.cj} / {comp.stuff}
                </dd>
                <dt>{tr('Datos por afluente', 'Data per tributary')}</dt>
                <dd>
                  {spec.dataPerTrib} (+1)
                </dd>
              </dl>
            </div>
          </div>
        </Card>

        <div className="stats-grid">
          <Stat
            label={tr('Ida y vuelta', 'Round trip')}
            value={
              <Badge ok={recoveredAll}>
                {sim.recovery.ok}/{sim.recovery.total} E1
              </Badge>
            }
            sub={
              recoveredAll
                ? tr(`${num(sim.recovery.checkedBits, 0)} bits recuperados idénticos`, `${num(sim.recovery.checkedBits, 0)} bits recovered identical`)
                : tr(`${num(sim.recovery.badBits, 0)} bits erróneos de ${num(sim.recovery.checkedBits, 0)}`, `${num(sim.recovery.badBits, 0)} wrong bits of ${num(sim.recovery.checkedBits, 0)}`)
            }
            tone={recoveredAll ? 'good' : 'bad'}
          />
          <Stat
            label={tr('Bits volteados en la línea', 'Bits flipped on the line')}
            value={num(sim.injected, 0)}
            sub={ber ? `BER ${ber.toExponential(0)}` : tr('línea sin errores', 'error-free line')}
          />
          <Stat
            label={tr('Fluctuación de espera (E1 observado)', 'Waiting-time jitter (observed E1)')}
            value={`${num(sim.jitterUi, 2)} UI`}
            sub={tr('pico a pico en el afluente tras el 2/8; nunca pasa de 1 bit', 'peak to peak on the tributary after the 2/8; never over 1 bit')}
          />
        </div>

        <Card title={tr('Razón de justificación: medida vs. teoría', 'Justification ratio: measured vs theory')}>
          <table className="table">
            <thead>
              <tr>
                <th>{tr('Nivel', 'Level')}</th>
                <th>{tr('Norma', 'Standard')}</th>
                <th>{tr('Nominal', 'Nominal')}</th>
                <th>{tr('Teoría con sus ppm', 'Theory with your ppm')}</th>
                <th>{tr('Medida', 'Measured')}</th>
                <th>{tr('Peor desvío', 'Worst gap')}</th>
                <th>{tr('Tramas', 'Frames')}</th>
              </tr>
            </thead>
            <tbody>
              {sim.levels.map((l) => (
                <tr key={l.name}>
                  <td>
                    <strong>{l.spec.name}</strong> → {l.name}
                  </td>
                  <td>{l.spec.recommendation}</td>
                  <td>{num(nominalStuffRatio(l.spec), 3)}</td>
                  <td>{num(l.theory, 3)}</td>
                  <td>{num(l.measured, 3)}</td>
                  <td>
                    <Badge ok={l.worst < 0.03}>{num(l.worst, 3)}</Badge>
                  </td>
                  <td>{num(l.frames, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            {tr(
              'Razón = fracción de tramas en que el bit S es relleno. Un afluente más rápido que el nominal rellena menos; uno más lento, más. Con relojes nominales sale 0,424 / 0,436 / 0,419 como en G.742 y G.751.',
              'Ratio = share of frames in which the S bit is stuffing. A tributary faster than nominal stuffs less, a slower one more. With nominal clocks you get 0.424 / 0.436 / 0.419 as in G.742 and G.751.',
            )}
          </p>
        </Card>

        <Card
          title={tr(`¿Dónde está mi E1 dentro de la ${params.top}?`, `Where is my E1 inside the ${params.top}?`)}
          aside={
            <div className="field inline">
              <label htmlFor="tsel">{tr('Intervalo', 'Time slot')}</label>
              <select id="tsel" value={ts} onChange={(e) => setTs(Number(e.target.value))}>
                {Array.from({ length: 32 }, (_, i) => (
                  <option key={i} value={i}>
                    TS{i}
                  </option>
                ))}
              </select>
            </div>
          }
        >
          <LineChart
            ariaLabel={tr('Posición del intervalo dentro de cada trama', 'Position of the time slot in every frame')}
            series={[{ name: 'pos', color: 'var(--accent)', points: trackPoints }]}
            xLabel={tr('número de trama', 'frame number')}
            yLabel={tr('posición del bit (0…)', 'bit position (0…)')}
            yDomain={[0, spec.frameBits]}
            markers={[{ x: frameIdx, color: 'var(--warn)' }]}
          />
          <p className="hint">
            {tr(
              `El bit 1 de TS${ts} del E1 ${params.selE1 + 1} cae en un lugar distinto en cada trama, porque la justificación mueve todo. Por eso en PDH no se puede sacar un E1 sin bajar nivel por nivel.`,
              `Bit 1 of TS${ts} of E1 ${params.selE1 + 1} lands in a different place in every frame, because justification shifts everything. That is why in PDH you cannot pull an E1 out without going down level by level.`,
            )}
          </p>
        </Card>
      </main>
    </div>
  );
}
