import { useMemo, useState } from 'react';
import { analyticPerformance, E1_OBJECTIVES, hopQos, simulatePerformance } from '../core/perf';
import { useI18n } from '../i18n';
import { Badge, Card, Legend, LineChart, Segmented, Slider, Stat } from './ui';

type Source = 'ber' | 'radio';

function fmtRatio(v: number): string {
  if (v === 0) return '0';
  return v >= 0.01 ? v.toFixed(3) : v.toExponential(1);
}

export function QualityPanel() {
  const { tr, num } = useI18n();
  const [source, setSource] = useState<Source>('radio');
  const [berExp, setBerExp] = useState(5);
  const [km, setKm] = useState(45);
  const [freq, setFreq] = useState(7500);
  const [margin, setMargin] = useState(34);
  const [terrain, setTerrain] = useState(1);
  const [hops, setHops] = useState(1);
  const [seconds, setSeconds] = useState(3600);
  const [share, setShare] = useState(10);

  const hop = useMemo(() => hopQos({ distKm: km, freqMHz: freq, fadeMarginDb: margin, terrainFactor: terrain }), [km, freq, margin, terrain]);
  const berClear = source === 'ber' ? 10 ** -berExp : hop.berNominal;

  const sim = useMemo(() => simulatePerformance(berClear, seconds, 7), [berClear, seconds]);
  const th = useMemo(() => analyticPerformance(berClear), [berClear]);

  const radioSes = hop.sesr * hops;
  const budget = (E1_OBJECTIVES.sesr * share) / 100;
  const radioOk = radioSes <= budget;

  const sweep = useMemo(() => {
    const exps = Array.from({ length: 41 }, (_, i) => 3 + i * 0.1); // BER 1e-3 .. 1e-7
    const pts = (k: 'esr' | 'sesr' | 'bber'): [number, number][] =>
      exps.map((e) => [10 ** -e, Math.max(analyticPerformance(10 ** -e)[k], 1e-12)]);
    return [
      { name: 'ESR', color: 'var(--accent)', points: pts('esr') },
      { name: 'SESR', color: 'var(--bad)', points: pts('sesr') },
      { name: 'BBER', color: 'var(--warn)', points: pts('bber') },
    ];
  }, []);

  const rows: { k: 'esr' | 'sesr' | 'bber'; name: string; obj: number; simv: number; thv: number; ok: boolean }[] = [
    { k: 'esr', name: 'ESR', obj: E1_OBJECTIVES.esr, simv: sim.esr, thv: th.esr, ok: sim.meets.esr },
    { k: 'sesr', name: 'SESR', obj: E1_OBJECTIVES.sesr, simv: sim.sesr, thv: th.sesr, ok: sim.meets.sesr },
    { k: 'bber', name: 'BBER', obj: E1_OBJECTIVES.bber, simv: sim.bber, thv: th.bber, ok: sim.meets.bber },
  ];

  return (
    <div className="stack">
      <Card title={tr('De un radioenlace a la calidad de un E1', 'From a radio link to E1 quality')}>
        <div className="two-col">
          <div className="stack">
            <Segmented
              label={tr('Origen de los errores', 'Source of errors')}
              value={source}
              onChange={setSource}
              options={[
                { value: 'radio', label: tr('Salto de radioenlace', 'Radio hop') },
                { value: 'ber', label: tr('BER directo', 'Direct BER') },
              ]}
            />
            {source === 'radio' ? (
              <>
                <Slider label={tr('Longitud del salto', 'Hop length')} value={km} min={5} max={100} unit="km" onChange={setKm} />
                <Slider label={tr('Frecuencia', 'Frequency')} value={freq} min={1500} max={15000} step={100} unit="MHz" onChange={setFreq} />
                <Slider label={tr('Margen de desvanecimiento', 'Fade margin')} value={margin} min={5} max={50} unit="dB" onChange={setMargin} hint={tr('El mismo que calcula radio-link-planner.', 'The same figure radio-link-planner computes.')} />
                <Slider
                  label={tr('Factor de terreno', 'Terrain factor')}
                  value={terrain}
                  min={0.25}
                  max={4}
                  step={0.25}
                  onChange={setTerrain}
                  hint={tr('4 = llano o sobre agua · 1 = medio · 0,25 = montañoso', '4 = flat or over water · 1 = average · 0.25 = mountainous')}
                />
                <Slider label={tr('Saltos en serie', 'Hops in series')} value={hops} min={1} max={6} onChange={setHops} />
                <Slider label={tr('Parte del objetivo SES asignada al radio', 'Share of the SES objective given to the radio')} value={share} min={1} max={100} unit="%" onChange={setShare} hint={tr('Supuesto del emulador, no de la norma.', 'Emulator assumption, not from the standard.')} />
              </>
            ) : (
              <Slider label={tr('Tasa de error de bit', 'Bit error ratio')} value={berExp} min={3} max={9} format={(v) => `10⁻${v}`} onChange={setBerExp} />
            )}
            <Slider label={tr('Tiempo observado', 'Observation time')} value={seconds} min={600} max={14400} step={600} format={(v) => `${v / 3600 >= 1 ? num(v / 3600, 1) + ' h' : v / 60 + ' min'}`} onChange={setSeconds} />
          </div>

          <div className="stack">
            {source === 'radio' && (
              <div className="stats-grid">
                <Stat label={tr('Disponibilidad del salto', 'Hop availability')} value={`${num(hop.availabilityPct, 4)} %`} sub="Vigants-Barnett" />
                <Stat label={tr('BER en cielo claro', 'Clear-sky BER')} value={berClear < 1e-15 ? '< 1e-15' : berClear.toExponential(1)} sub={tr('QPSK coherente, umbral 10⁻⁶', 'coherent QPSK, 10⁻⁶ threshold')} />
                <Stat
                  label={tr('SES por desvanecimiento', 'Fading SES')}
                  value={fmtRatio(radioSes)}
                  tone={radioOk ? 'good' : 'bad'}
                  sub={tr(`presupuesto ${fmtRatio(budget)} (${share} % de 0,002)`, `budget ${fmtRatio(budget)} (${share} % of 0.002)`)}
                />
              </div>
            )}
            <table className="table">
              <thead>
                <tr>
                  <th>{tr('Parámetro G.826', 'G.826 parameter')}</th>
                  <th>{tr('Objetivo', 'Objective')}</th>
                  <th>{tr('Simulado', 'Simulated')}</th>
                  <th>{tr('Teórico', 'Theory')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.k}>
                    <td>
                      <strong>{r.name}</strong>
                    </td>
                    <td>{fmtRatio(r.obj)}</td>
                    <td>{fmtRatio(r.simv)}</td>
                    <td>{fmtRatio(r.thv)}</td>
                    <td>
                      <Badge ok={r.ok}>{r.ok ? tr('cumple', 'meets') : tr('no cumple', 'fails')}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="stats-grid">
              <Stat label="ES" value={sim.es} sub={tr('segundos con errores', 'errored seconds')} />
              <Stat label="SES" value={sim.ses} sub={tr('≥ 30 % de bloques erróneos', '≥ 30 % errored blocks')} />
              <Stat label="BBE" value={sim.bbe} sub={tr('bloques erróneos de fondo', 'background block errors')} />
              <Stat label="UAS" value={sim.uas} tone={sim.uas ? 'bad' : undefined} sub={tr('tras 10 SES seguidos', 'after 10 consecutive SES')} />
            </div>
            <p className="hint">
              {tr(
                'Un bloque son los 2048 bits de una submultitrama CRC-4, 1000 por segundo: es lo que el CRC-4 cuenta. Se simula bloque a bloque con una semilla fija; la columna teórica es la binomial exacta.',
                'A block is the 2048 bits of a CRC-4 submultiframe, 1000 per second: it is what CRC-4 counts. It is simulated block by block with a fixed seed; the theory column is the exact binomial.',
              )}
            </p>
          </div>
        </div>
      </Card>

      <Card title={tr('Cómo se degrada un E1 con el BER', 'How an E1 degrades with BER')}>
        <Legend items={sweep} />
        <LineChart
          ariaLabel={tr('ESR, SESR y BBER frente al BER', 'ESR, SESR and BBER against BER')}
          series={sweep}
          xLog
          yLog
          xDomain={[1e-7, 1e-3]}
          yDomain={[1e-9, 1]}
          xLabel="BER"
          yLabel={tr('razón', 'ratio')}
          height={260}
          hlines={[
            { y: E1_OBJECTIVES.esr, label: `ESR ${E1_OBJECTIVES.esr}`, color: 'var(--accent)' },
            { y: E1_OBJECTIVES.sesr, label: `SESR ${E1_OBJECTIVES.sesr}`, color: 'var(--bad)' },
            { y: E1_OBJECTIVES.bber, label: `BBER ${E1_OBJECTIVES.bber}`, color: 'var(--warn)' },
          ]}
        />
        <p className="hint">
          {tr(
            'Con BER ≈ 10⁻⁵ casi todos los segundos tienen algún bloque erróneo; hacia 1,5·10⁻⁴ casi todos los segundos son ya severamente erróneos (SES). Los objetivos son de extremo a extremo (G.826 tabla 1, clase 1,5–5 Mbit/s): un tramo concreto recibe sólo una parte.',
            'At BER ≈ 10⁻⁵ almost every second has some errored block; around 1.5·10⁻⁴ almost every second is already severely errored (SES). The objectives are end to end (G.826 table 1, 1.5–5 Mbit/s class): a single section gets only a share.',
          )}
        </p>
      </Card>
    </div>
  );
}
