import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { E1_PER_LEVEL } from '../core/hierarchy';
import {
  LEVEL_NAME,
  SOUTH_PERU,
  distanceKm,
  nodeCosts,
  planSummary,
  propagateAlarms,
  radioQos,
  stationOf,
  trunkLengthKm,
  trunkLoad,
  type Fault,
  type FaultMode,
  type Network,
  type Signal,
  type Strategy,
  type Trunk,
} from '../core/network';
import { useI18n } from '../i18n';
import type { NetView } from '../state/urlState';
import { Badge, Card, Segmented, Stat } from './ui';

const LEVEL_COLOR = { 2: '#0ea5e9', 3: '#14b8a6', 4: '#f59e0b' } as const;
const LEVEL_WEIGHT = { 2: 3, 3: 5, 4: 7 } as const;
const SIGNAL_COLOR: Record<Signal, string | null> = { ok: null, los: '#dc2626', ais: '#d97706', rai: '#9333ea' };

export function NetworkPanel({ dark, view, setView }: { dark: boolean; view: NetView; setView: (v: NetView) => void }) {
  const { tr, num } = useI18n();
  const [net, setNet] = useState<Network>(SOUTH_PERU);
  const { selected, strategy, fault } = view;
  const setSelected = (id: string) => setView({ ...view, selected: id });
  const setStrategy = (s: Strategy) => setView({ ...view, strategy: s });
  const setFault = (f: Fault | null) => setView({ ...view, fault: f });
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);

  const trunk = net.trunks.find((t) => t.id === selected)!;
  const alarms = useMemo(() => net.trunks.map((t) => propagateAlarms(t, fault)), [net, fault]);
  const naive = useMemo(() => planSummary(net, 'naive'), [net]);
  const optimised = useMemo(() => planSummary(net, 'optimised'), [net]);
  const active = strategy === 'optimised' ? optimised : naive;
  const costs = useMemo(() => nodeCosts(net, trunk, strategy), [net, trunk, strategy]);
  const load = trunkLoad(net, trunk);
  const qos = radioQos(net, trunk);

  // map set-up
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = L.map(mapEl.current, { zoomControl: true, scrollWheelZoom: true });
    const bounds = L.latLngBounds(SOUTH_PERU.stations.map((s) => [s.lat, s.lng] as [number, number]));
    m.fitBounds(bounds, { padding: [28, 28] });
    // the container may not have its final size yet: fit again once it does
    const raf = requestAnimationFrame(() => {
      m.invalidateSize();
      m.fitBounds(bounds, { padding: [28, 28] });
    });
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    return () => {
      cancelAnimationFrame(raf);
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    tiles.current?.remove();
    tiles.current = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 14,
      className: dark ? 'tiles-dark' : '',
      attribution: '© OpenStreetMap contributors',
    }).addTo(m);
    tiles.current.bringToBack();
  }, [dark]);

  // draw trunks and stations
  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    const alarmed = new Map<string, Set<string>>();
    net.trunks.forEach((t, ti) => {
      const st = alarms[ti]!;
      t.path.forEach((id, i) => {
        const r = st.nodes[i]!.raised;
        if (r.length) alarmed.set(id, new Set([...(alarmed.get(id) ?? []), ...r]));
      });
      for (let i = 0; i + 1 < t.path.length; i++) {
        const a = stationOf(net, t.path[i]!);
        const b = stationOf(net, t.path[i + 1]!);
        const sig = st.links[i]!;
        const worst: Signal = [sig.forward, sig.backward].includes('los') ? 'los' : [sig.forward, sig.backward].includes('ais') ? 'ais' : [sig.forward, sig.backward].includes('rai') ? 'rai' : 'ok';
        const color = SIGNAL_COLOR[worst] ?? LEVEL_COLOR[t.level];
        const line = L.polyline(
          [
            [a.lat, a.lng],
            [b.lat, b.lng],
          ],
          {
            color,
            weight: LEVEL_WEIGHT[t.level] + (t.id === selected ? 3 : 0),
            opacity: t.id === selected ? 0.95 : 0.6,
            dashArray: t.medium === 'radio' ? '2 9' : worst === 'los' ? '10 8' : undefined,
            lineCap: 'round',
          },
        ).addTo(g);
        line.bindTooltip(`${t.name} · ${LEVEL_NAME[t.level]} · ${t.medium === 'radio' ? tr('radio', 'radio') : tr('fibra', 'fibre')}`, { sticky: true });
        line.on('click', () => setSelected(t.id));
      }
    });
    for (const s of net.stations) {
      const al = alarmed.get(s.id);
      const mk = L.circleMarker([s.lat, s.lng], {
        radius: 8,
        color: al ? '#dc2626' : '#0f766e',
        weight: 3,
        fillColor: dark ? '#0b1220' : '#ffffff',
        fillOpacity: 1,
      }).addTo(g);
      mk.bindTooltip(`<strong>${s.name}</strong>${al ? ' · ' + [...al].join('/') : ''}`, { permanent: true, direction: 'top', offset: [0, -6], className: 'station-label' });
    }
  }, [net, alarms, selected, dark, tr]);

  const setE1 = (id: string, v: number) =>
    setNet({ ...net, circuits: net.circuits.map((c) => (c.id === id ? { ...c, e1: Math.max(0, Math.min(64, Math.round(v))) } : c)) });

  const trunkCircuits = net.circuits.filter((c) => trunk.path.includes(c.from) && trunk.path.includes(c.to));
  const faultOn = fault?.trunk === trunk.id ? fault : null;
  const st = alarms[net.trunks.indexOf(trunk)]!;

  const setFaultLink = (link: number, mode: FaultMode) => setFault({ trunk: trunk.id, link, mode });

  return (
    <div className="tab-grid">
      <aside className="sidebar" aria-label={tr('Red', 'Network')}>
        <Card title={tr('Troncales', 'Trunks')}>
          <ul className="trunk-list">
            {net.trunks.map((t, i) => {
              const l = trunkLoad(net, t);
              const bad = alarms[i]!.nodes.some((n) => n.raised.length) || l.overloaded;
              return (
                <li key={t.id}>
                  <button type="button" className={`trunk-btn ${t.id === selected ? 'sel' : ''}`} aria-pressed={t.id === selected} onClick={() => setSelected(t.id)}>
                    <span className="dot" style={{ background: LEVEL_COLOR[t.level] }} aria-hidden="true" />
                    <span className="grow">
                      <strong>{t.name}</strong>
                      <span className="hint">
                        {t.path.map((p) => stationOf(net, p).name).join(' – ')} · {LEVEL_NAME[t.level]} · {t.medium === 'radio' ? tr('radio', 'radio') : tr('fibra', 'fibre')}
                      </span>
                    </span>
                    <span className={`load ${l.overloaded ? 'load-bad' : ''}`}>
                      {l.demandE1}/{l.capacityE1}
                    </span>
                    {bad && <span aria-label={tr('con problemas', 'has problems')}>⚠</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="hint">{tr('E1 pedidos / capacidad del flujo. Haz clic en una línea del mapa para elegirla.', 'E1 requested / stream capacity. Click a line on the map to select it.')}</p>
        </Card>

        <Card title={tr('Inyectar un fallo', 'Inject a fault')}>
          <div className="stack">
            <label className="label" htmlFor="flink">
              {tr('Enlace de', 'Link of')} {trunk.name}
            </label>
            <select id="flink" value={faultOn ? faultOn.link : -1} onChange={(e) => (Number(e.target.value) < 0 ? setFault(null) : setFaultLink(Number(e.target.value), faultOn?.mode ?? 'cut'))}>
              <option value={-1}>{tr('Sin fallo', 'No fault')}</option>
              {trunk.path.slice(0, -1).map((id, i) => (
                <option key={i} value={i}>
                  {stationOf(net, id).name} – {stationOf(net, trunk.path[i + 1]!).name}
                </option>
              ))}
            </select>
            <Segmented
              label={tr('Tipo de fallo', 'Fault type')}
              value={faultOn?.mode ?? 'cut'}
              onChange={(mode) => faultOn && setFaultLink(faultOn.link, mode)}
              options={[
                { value: 'cut', label: tr('Corte total', 'Full cut') },
                { value: 'forward', label: tr('Sólo ida', 'Forward only') },
                { value: 'backward', label: tr('Sólo vuelta', 'Backward only') },
              ]}
            />
            <ul className="signal-key">
              <li><span className="swatch" style={{ background: SIGNAL_COLOR.los! }} /> LOS · {tr('pérdida de señal', 'loss of signal')}</li>
              <li><span className="swatch" style={{ background: SIGNAL_COLOR.ais! }} /> AIS · {tr('señal de indicación de alarma (todo unos)', 'alarm indication signal (all ones)')}</li>
              <li><span className="swatch" style={{ background: SIGNAL_COLOR.rai! }} /> RAI · {tr('alarma remota (bit A de TS0)', 'remote alarm (bit A of TS0)')}</li>
            </ul>
          </div>
        </Card>
      </aside>

      <main className="stage-col">
        <div className="net-map card" role="region" aria-label={tr('Mapa de la red PDH del sur del Perú', 'Map of the southern Peru PDH network')}>
          <div ref={mapEl} className="map" />
          <div className="map-legend" aria-hidden="true">
            {([4, 3, 2] as const).map((l) => (
              <span key={l}>
                <i style={{ background: LEVEL_COLOR[l], height: LEVEL_WEIGHT[l] }} /> {LEVEL_NAME[l]} ({E1_PER_LEVEL[l]} E1)
              </span>
            ))}
            <span>
              <i className="dotted" /> {tr('radio', 'radio')}
            </span>
          </div>
        </div>

        <Card
          title={tr('Costo de sacar circuitos en cada estación', 'Cost of dropping circuits at each station')}
          aside={
            <Segmented
              label={tr('Asignación de intervalos', 'Slot assignment')}
              value={strategy}
              onChange={setStrategy}
              options={[
                { value: 'naive', label: tr('En orden de pedido', 'In request order') },
                { value: 'optimised', label: tr('Agrupada', 'Grouped') },
              ]}
            />
          }
        >
          <div className="stats-grid">
            <Stat
              label={tr('Unidades MUX/DEMUX en PDH', 'PDH MUX/DEMUX units')}
              value={active.pdhUnits}
              sub={tr(`vs. ${active.sdhUnits} ADM en SDH`, `vs. ${active.sdhUnits} ADM in SDH`)}
              tone="bad"
            />
            <Stat
              label={tr('Ahorro de agrupar', 'Saving from grouping')}
              value={`${naive.pdhUnits - optimised.pdhUnits}`}
              sub={tr(`${naive.pdhUnits} → ${optimised.pdhUnits} unidades`, `${naive.pdhUnits} → ${optimised.pdhUnits} units`)}
              tone={naive.pdhUnits > optimised.pdhUnits ? 'good' : undefined}
            />
            <Stat
              label={tr('Retardo añadido (suma de la red)', 'Added delay (network total)')}
              value={`${num(active.pdhDelayUs, 0)} µs`}
              sub={tr(`vs. ${num(active.nodes.reduce((a, n) => a + n.cost.sdhDelayUs, 0), 0)} µs en SDH`, `vs. ${num(active.nodes.reduce((a, n) => a + n.cost.sdhDelayUs, 0), 0)} µs in SDH`)}
            />
          </div>

          <h3 className="sub">
            {trunk.name} · {LEVEL_NAME[trunk.level]} · {num(trunkLengthKm(net, trunk), 0)} km
          </h3>
          <div className="loadbar" role="img" aria-label={tr(`${load.demandE1} de ${load.capacityE1} E1 ocupados`, `${load.demandE1} of ${load.capacityE1} E1 used`)}>
            <div style={{ width: `${Math.min(100, (load.demandE1 / load.capacityE1) * 100)}%` }} className={load.overloaded ? 'bad' : ''} />
          </div>
          <p className="hint">
            {load.overloaded
              ? tr(`Sobrecargado: hace falta al menos ${load.neededLevel ? LEVEL_NAME[load.neededLevel] : 'más que un E4'}.`, `Overloaded: at least ${load.neededLevel ? LEVEL_NAME[load.neededLevel] : 'more than an E4'} is needed.`)
              : tr(`${load.demandE1} de ${load.capacityE1} E1 en uso.`, `${load.demandE1} of ${load.capacityE1} E1 in use.`)}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>{tr('Estación', 'Station')}</th>
                <th>{tr('E1 que salen o entran', 'E1 dropped or added')}</th>
                <th>DEMUX</th>
                <th>MUX</th>
                <th>PDH</th>
                <th>SDH</th>
                <th>{tr('Alarmas', 'Alarms')}</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((c, i) => (
                <tr key={c.station}>
                  <td>
                    <strong>{stationOf(net, c.station).name}</strong>
                  </td>
                  <td>{c.droppedE1}</td>
                  <td>{c.cost.pdhDemux}</td>
                  <td>{c.cost.pdhMux}</td>
                  <td>
                    <strong>{c.cost.pdhUnits}</strong>
                  </td>
                  <td>{c.cost.sdhUnits}</td>
                  <td>{st.nodes[i]!.raised.length ? st.nodes[i]!.raised.join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            {tr(
              'Cada E1 que sale de un E4 obliga a bajar por 140/34, 34/8 y 8/2 y volver a subir: 3 + 3 unidades. Dos E1 de la misma rama comparten equipos; repartidos por todo el flujo, no. Por eso agrupar los intervalos por estación ahorra equipo.',
              'Every E1 leaving an E4 forces going down through 140/34, 34/8 and 8/2 and back up: 3 + 3 units. Two E1 in the same branch share equipment; scattered across the stream they do not. That is why grouping slots by station saves equipment.',
            )}
          </p>
        </Card>

        <div className="two-col">
          <Card title={tr('Circuitos (E1)', 'Circuits (E1)')}>
            <ul className="circuits">
              {trunkCircuits.map((c) => (
                <li key={c.id}>
                  <span>
                    {stationOf(net, c.from).name} ↔ {stationOf(net, c.to).name}
                    <span className="hint"> · {num(distanceKm(stationOf(net, c.from), stationOf(net, c.to)), 0)} km</span>
                  </span>
                  <input type="number" min={0} max={64} value={c.e1} onChange={(e) => setE1(c.id, Number(e.target.value))} aria-label={`${stationOf(net, c.from).name} – ${stationOf(net, c.to).name} E1`} />
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-small" onClick={() => setNet({ ...net, circuits: SOUTH_PERU.circuits })}>
              {tr('Restaurar demanda', 'Reset demand')}
            </button>
          </Card>

          <Card title={tr('Calidad del enlace', 'Link quality')}>
            {qos ? (
              <div className="stack">
                <div className="stats-grid">
                  <Stat label={tr('Saltos', 'Hops')} value={qos.hops.length} sub={`${num(qos.hopKm, 1)} km ${tr('c/u', 'each')}`} />
                  <Stat label={tr('Disponibilidad', 'Availability')} value={`${num(qos.total.availabilityPct, 4)} %`} sub="Vigants-Barnett" />
                  <Stat label="SES" value={qos.total.sesr.toExponential(1)} sub={tr('por desvanecimiento', 'from fading')} />
                </div>
                <Badge ok={qos.total.sesr <= 0.0002}>
                  {qos.total.sesr <= 0.0002 ? tr('dentro del 10 % del objetivo SES de G.826', 'within 10 % of the G.826 SES objective') : tr('por encima del 10 % del objetivo SES', 'over 10 % of the SES objective')}
                </Badge>
                <p className="hint">
                  {tr(
                    `Margen ${(trunk as Trunk).radio!.fadeMarginDb} dB a ${(trunk as Trunk).radio!.freqMHz} MHz. Cambia los números en la pestaña Calidad.`,
                    `Margin ${(trunk as Trunk).radio!.fadeMarginDb} dB at ${(trunk as Trunk).radio!.freqMHz} MHz. Change the numbers in the Quality tab.`,
                  )}
                </p>
              </div>
            ) : (
              <p className="hint">{tr('Este troncal es de fibra: sin desvanecimiento por multitrayecto. Elige uno de radio.', 'This trunk is fibre: no multipath fading. Pick a radio one.')}</p>
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}
