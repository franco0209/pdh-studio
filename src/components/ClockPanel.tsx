import { useEffect, useMemo, useState } from 'react';
import { offsetBps, simulateElasticBuffer, slipIntervalSeconds, tieUi } from '../core/clock';
import { E2_SPEC, E3_SPEC, E4_SPEC, justificationRangePpm } from '../core/mux';
import { buildTree } from '../core/tree';
import { useI18n } from '../i18n';
import { Card, CHART_W, Legend, LineChart, Slider, Stat } from './ui';

function humanTime(s: number, tr: (a: string, b: string) => string, num: (n: number, d?: number) => string): string {
  if (!Number.isFinite(s)) return tr('nunca', 'never');
  if (s < 120) return `${num(s, 2)} s`;
  if (s < 7200) return `${num(s / 60, 1)} min`;
  if (s < 172800) return `${num(s / 3600, 1)} h`;
  return `${num(s / 86400, 1)} ${tr('días', 'days')}`;
}

export function ClockPanel() {
  const { tr, num } = useI18n();
  const [ppmA, setPpmA] = useState(50);
  const [ppmB, setPpmB] = useState(-50);
  const [secs, setSecs] = useState(12);
  const [t, setT] = useState(0);
  const [play, setPlay] = useState(false);

  const run = useMemo(() => simulateElasticBuffer({ ppmWrite: ppmA, ppmRead: ppmB, seconds: secs, steps: 1200 }), [ppmA, ppmB, secs]);
  const interval = slipIntervalSeconds(ppmA, ppmB);
  const bps = offsetBps(2_048_000, ppmA, ppmB);
  const perDay = Number.isFinite(interval) ? 86400 / interval : 0;

  useEffect(() => {
    if (!play) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((x) => {
        const nx = x + dt * Math.max(secs / 12, 0.25);
        return nx > secs ? 0 : nx;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [play, secs]);

  const idx = Math.min(run.samples.length - 1, Math.round((t / secs) * (run.samples.length - 1)));
  const level = run.samples[idx]!.level;
  const half = run.halfWindow;
  const fillPct = Math.max(0, Math.min(100, ((level + half) / (2 * half)) * 100));
  const slipsSoFar = run.slips.filter((s) => s.t <= t).length;

  // justification ratio against the tributary clock error
  const ratioCurves = useMemo(() => {
    const ppms = Array.from({ length: 61 }, (_, i) => -3000 + i * 100);
    const line = (spec: typeof E2_SPEC): [number, number][] =>
      ppms.map((p) => {
        const bpf = (spec.tribRate * (1 + p * 1e-6) * spec.frameBits) / spec.lineRate;
        return [p, Math.max(0, Math.min(1, spec.dataPerTrib + 1 - bpf))];
      });
    return [
      { name: 'E2', color: 'var(--accent)', points: line(E2_SPEC) },
      { name: 'E3', color: 'var(--warn)', points: line(E3_SPEC) },
      { name: 'E4', color: '#a855f7', points: line(E4_SPEC) },
    ];
  }, []);

  const [measured, setMeasured] = useState<[number, number][]>([]);
  useEffect(() => {
    const id = setTimeout(() => {
      const pts: [number, number][] = [];
      for (const p of [-2600, -1800, -900, 0, 700, 1400, 1950]) {
        const tree = buildTree({ top: 'E2', e1Ppm: [p, p, p, p] });
        const n = 2500;
        for (let i = 0; i < n; i++) tree.nextTopFrame();
        pts.push([p, tree.stats.E2.stuffed[0]![0]! / n]);
      }
      setMeasured(pts);
    }, 60);
    return () => clearTimeout(id);
  }, []);

  const range = justificationRangePpm(E2_SPEC);

  return (
    <div className="stack">
      <Card title={tr('Dos relojes, un búfer, un deslizamiento', 'Two clocks, one buffer, one slip')}>
        <div className="two-col">
          <div className="stack">
            <Slider label={tr('Reloj de escritura (extremo A)', 'Write clock (end A)')} value={ppmA} min={-50} max={50} unit="ppm" onChange={setPpmA} hint={tr('El E1 que llega.', 'The incoming E1.')} />
            <Slider label={tr('Reloj de lectura (extremo B)', 'Read clock (end B)')} value={ppmB} min={-50} max={50} unit="ppm" onChange={setPpmB} hint={tr('El equipo que lo recibe, con su propio reloj.', 'The equipment receiving it, on its own clock.')} />
            <Slider label={tr('Ventana de tiempo', 'Time window')} value={secs} min={2} max={120} unit="s" onChange={(v) => { setSecs(v); setT(0); }} />
            <div className="row">
              <button type="button" className="btn btn-small" aria-pressed={play} onClick={() => setPlay(!play)}>
                {play ? '⏸' : '▶'} {play ? tr('Pausa', 'Pause') : tr('Reproducir', 'Play')}
              </button>
              <input type="range" min={0} max={secs} step={secs / 600} value={t} onChange={(e) => setT(Number(e.target.value))} aria-label={tr('Instante', 'Time')} className="grow" />
            </div>
            <div className="stats-grid">
              <Stat label={tr('Diferencia de velocidad', 'Rate difference')} value={`${num(bps, 1)} bit/s`} sub={tr('entre ambos extremos', 'between both ends')} />
              <Stat
                label={tr('Un deslizamiento cada', 'One slip every')}
                value={humanTime(interval, tr, num)}
                sub={tr(`${num(perDay, 0)} al día · 256 bits ÷ ${num(bps, 1)} bit/s`, `${num(perDay, 0)} a day · 256 bits ÷ ${num(bps, 1)} bit/s`)}
                tone={interval < 3600 ? 'bad' : interval < 86400 ? 'warn' : 'good'}
              />
              <Stat label={tr('Deriva de fase en la ventana', 'Phase drift in the window')} value={`${num(tieUi(ppmA - ppmB, secs), 0)} UI`} sub={tr('1 UI = 488 ns; es «wander»', '1 UI = 488 ns; this is “wander”')} />
            </div>
          </div>

          <div>
            <div className="tank-row">
              <svg className="tank" viewBox="0 0 120 190" role="img" aria-label={tr(`Búfer elástico lleno al ${Math.round(fillPct)} %`, `Elastic buffer ${Math.round(fillPct)} % full`)}>
                <rect x="14" y="10" width="92" height="170" rx="10" className="tank-body" />
                <rect x="16" y={12 + 166 * (1 - fillPct / 100)} width="88" height={166 * (fillPct / 100)} rx="8" className="tank-fill" />
                <line x1="8" x2="112" y1="95" y2="95" className="tank-mid" />
              </svg>
              <div className="tank-info">
                <p className="hint">{tr('Arriba del todo: lleno, se pierde una trama. Abajo del todo: vacío, se repite una trama.', 'Top: full, a frame is lost. Bottom: empty, a frame repeats.')}</p>
                <Stat label={tr('Nivel del búfer', 'Buffer level')} value={`${num(level, 0)} bit`} sub={tr(`±${half} bit de ventana`, `±${half} bit window`)} />
                <Stat label={tr('Deslizamientos hasta ahora', 'Slips so far')} value={slipsSoFar} tone={slipsSoFar ? 'bad' : 'good'} sub={tr(`${run.slips.length} en la ventana`, `${run.slips.length} in the window`)} />
              </div>
            </div>
          </div>
        </div>

        <Legend items={[{ name: tr('Nivel del búfer (bit)', 'Buffer level (bit)'), color: 'var(--accent)' }, { name: tr('Deslizamiento', 'Slip'), color: 'var(--bad)', dashed: true }]} />
        <LineChart
          ariaLabel={tr('Nivel del búfer elástico en el tiempo, con los deslizamientos marcados', 'Elastic buffer level over time with slips marked')}
          series={[{ name: 'level', color: 'var(--accent)', points: run.samples.map((s) => [s.t, s.level]) }]}
          xDomain={[0, secs]}
          yDomain={[-half * 1.1, half * 1.1]}
          markers={run.slips.map((s) => ({ x: s.t }))}
          hlines={[
            { y: half, label: tr('límite: se descarta una trama', 'limit: a frame is dropped'), color: 'var(--warn)' },
            { y: -half, label: tr('límite: se repite una trama', 'limit: a frame is repeated'), color: 'var(--warn)' },
          ]}
          xLabel={tr('tiempo (s)', 'time (s)')}
          yLabel="bit"
          height={250}
        />
        <p className="hint">
          {tr(
            'Con ±50 ppm en cada extremo, unos 205 bit/s de diferencia, un deslizamiento cada 1,25 s: por eso un E1 libre es inservible. En la práctica los extremos se sincronizan desde un reloj de red (G.811) y los deslizamientos pasan a ser raros. El deslizamiento pierde o repite 125 µs: un chasquido en voz, un bloque erróneo en datos.',
            'With ±50 ppm at each end, about 205 bit/s of difference, there is one slip every 1.25 s: that is why a free-running E1 is useless. In practice the ends are synchronised from a network clock (G.811) and slips become rare. A slip drops or repeats 125 µs: a click on voice, an errored block on data.',
          )}
        </p>
      </Card>

      <Card title={tr('Justificación: cómo la multiplexación absorbe la diferencia', 'Justification: how multiplexing absorbs the difference')}>
        <Legend items={[...ratioCurves, { name: tr('Medida en el emulador (E2)', 'Measured in the emulator (E2)'), color: 'var(--text)' }]} />
        <div className="chart-over">
          <LineChart
            ariaLabel={tr('Razón de justificación contra la diferencia de reloj', 'Justification ratio against clock difference')}
            series={ratioCurves}
            xDomain={[-3000, 3000]}
            yDomain={[0, 1]}
            xLabel={tr('error del reloj del afluente (ppm)', 'tributary clock error (ppm)')}
            yLabel={tr('fracción de tramas con relleno', 'share of frames with stuffing')}
            height={260}
            hlines={[]}
          />
          <svg className="chart-dots" viewBox={`0 0 ${CHART_W} 260`} aria-hidden="true">
            {measured.map(([p, r]) => (
              <circle key={p} cx={52 + ((p + 3000) / 6000) * (CHART_W - 52 - 12)} cy={10 + (1 - r) * (260 - 10 - 36)} r={5} fill="var(--text)" stroke="var(--surface)" strokeWidth={2} />
            ))}
          </svg>
        </div>
        <p className="hint">
          {tr(
            `La razón baja con el reloj del afluente: más rápido, menos relleno. Cada nivel absorbe una ventana distinta (E2: de ${num(range.lowPpm, 0)} a +${num(range.highPpm, 0)} ppm; E3 y E4 mucho menos porque llevan más bits por trama), pero la ventana siempre es enorme frente a los ±15 a ±50 ppm que permite la norma. Los puntos son medidas reales del multiplexor 2/8, incluso fuera de norma.`,
            `The ratio falls with the tributary clock: faster, less stuffing. Each level absorbs a different window (E2: from ${num(range.lowPpm, 0)} to +${num(range.highPpm, 0)} ppm; E3 and E4 far less because they carry more bits per frame), yet the window is always huge next to the ±15 to ±50 ppm the standard allows. The dots are real measurements of the 2/8 multiplexer, even outside the standard.`,
          )}
        </p>
      </Card>
    </div>
  );
}
