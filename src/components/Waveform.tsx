import type { Pulse } from '../core/linecode';

/** Pulse train as drawn on an oscilloscope: +V, 0, -V, with substitutions marked. */
export function Waveform({
  bits,
  pulses,
  violations = [],
  fillers = [],
  label,
  slot = 22,
}: {
  bits: number[];
  pulses: Pulse[];
  violations?: number[];
  fillers?: number[];
  label: string;
  slot?: number;
}) {
  const n = pulses.length;
  const h = 84;
  const mid = 46;
  const amp = 22;
  const w = n * slot + 16;
  const vset = new Set(violations);
  const fset = new Set(fillers);
  const path: string[] = [];
  let y = mid;
  path.push(`M8,${mid}`);
  pulses.forEach((p, i) => {
    const x0 = 8 + i * slot;
    const yy = mid - p * amp;
    if (p === 0) {
      path.push(`L${x0},${mid}L${x0 + slot},${mid}`);
    } else {
      path.push(`L${x0},${mid}L${x0},${yy}L${x0 + slot * 0.7},${yy}L${x0 + slot * 0.7},${mid}L${x0 + slot},${mid}`);
    }
    y = mid;
  });
  void y;
  return (
    <div className="wave-scroll">
      <svg className="wave" width={w} height={h} role="img" aria-label={label} viewBox={`0 0 ${w} ${h}`}>
        <line x1={8} x2={w - 8} y1={mid} y2={mid} className="chart-grid" />
        <line x1={8} x2={w - 8} y1={mid - amp} y2={mid - amp} className="chart-grid" strokeDasharray="2 4" />
        <line x1={8} x2={w - 8} y1={mid + amp} y2={mid + amp} className="chart-grid" strokeDasharray="2 4" />
        <path d={path.join('')} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {bits.map((b, i) => (
          <text key={i} x={8 + i * slot + slot / 2} y={12} textAnchor="middle" className="chart-tick">
            {b}
          </text>
        ))}
        {pulses.map((p, i) =>
          vset.has(i) || fset.has(i) ? (
            <text
              key={`m${i}`}
              x={8 + i * slot + slot * 0.35}
              y={p > 0 ? mid - amp - 6 : mid + amp + 14}
              textAnchor="middle"
              className="wave-mark"
              fill={vset.has(i) ? 'var(--bad)' : 'var(--warn)'}
            >
              {vset.has(i) ? 'V' : 'B'}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
