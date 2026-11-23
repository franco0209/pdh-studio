import { useId, type ReactNode } from 'react';

export function Card({ title, children, aside, className = '' }: { title?: ReactNode; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title !== undefined && (
        <div className="card-head">
          <h2 className="card-title">{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  hint,
  format,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  hint?: ReactNode;
  format?: (v: number) => string;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="slider-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {format ? format(value) : value}
          {unit ? ` ${unit}` : ''}
        </output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className="chip" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** Verdict never relies on colour alone: icon + word. */
export function Badge({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={`badge ${ok ? 'badge-good' : 'badge-bad'}`}>
      <span aria-hidden="true">{ok ? '✓' : '✕'}</span> {children}
    </span>
  );
}

export interface Series {
  name: string;
  color: string;
  points: [number, number][];
  dashed?: boolean;
  /** Draw as a staircase (levels held until the next sample). */
  step?: boolean;
}

/** Minimal hand-written SVG line chart, same spirit as the profile chart of the link planner. */
export const CHART_W = 900;

export function LineChart({
  series,
  width = CHART_W,
  height = 240,
  xLabel,
  yLabel,
  xLog,
  yLog,
  yDomain,
  xDomain,
  markers,
  hlines,
  ariaLabel,
}: {
  series: Series[];
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  xLog?: boolean;
  yLog?: boolean;
  yDomain?: [number, number];
  xDomain?: [number, number];
  markers?: { x: number; label?: string; color?: string }[];
  hlines?: { y: number; label: string; color?: string }[];
  ariaLabel: string;
}) {
  const m = { l: 52, r: 12, t: 10, b: 36 };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;
  const all = series.flatMap((s) => s.points);
  const tx = (v: number) => (xLog ? Math.log10(Math.max(v, 1e-300)) : v);
  const ty = (v: number) => (yLog ? Math.log10(Math.max(v, 1e-300)) : v);
  const xs = all.map((p) => tx(p[0]));
  const ys = all.map((p) => ty(p[1]));
  const xmin = xDomain ? tx(xDomain[0]) : Math.min(...xs, 0);
  const xmax = xDomain ? tx(xDomain[1]) : Math.max(...xs, 1);
  let ymin = yDomain ? ty(yDomain[0]) : Math.min(...ys, 0);
  let ymax = yDomain ? ty(yDomain[1]) : Math.max(...ys, 1);
  if (ymin === ymax) {
    ymin -= 1;
    ymax += 1;
  }
  const px = (v: number) => m.l + ((tx(v) - xmin) / (xmax - xmin || 1)) * w;
  const py = (v: number) => m.t + h - ((ty(v) - ymin) / (ymax - ymin || 1)) * h;

  const ticks = (min: number, max: number, log: boolean, n = 5): { v: number; label: string }[] => {
    if (log) {
      const out: { v: number; label: string }[] = [];
      for (let e = Math.ceil(min); e <= Math.floor(max); e++) out.push({ v: 10 ** e, label: `1e${e}` });
      return out.length > 8 ? out.filter((_, i) => i % 2 === 0) : out;
    }
    const raw = (max - min) / n;
    const mag = 10 ** Math.floor(Math.log10(raw || 1));
    const f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
    const out: { v: number; label: string }[] = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
      const r = Math.abs(v) < step * 1e-9 ? 0 : v;
      out.push({ v: r, label: Number.isInteger(step) ? r.toFixed(0) : r.toFixed(Math.max(0, -Math.floor(Math.log10(step)))) });
    }
    return out;
  };
  const xt = ticks(xmin, xmax, !!xLog);
  const yt = ticks(ymin, ymax, !!yLog);

  const path = (s: Series) => {
    const pts = s.points.map((p) => [px(p[0]), py(p[1])] as const);
    if (!pts.length) return '';
    let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      if (s.step) d += `H${pts[i]![0].toFixed(1)}V${pts[i]![1].toFixed(1)}`;
      else d += `L${pts[i]![0].toFixed(1)},${pts[i]![1].toFixed(1)}`;
    }
    return d;
  };

  const clipId = useId().replace(/:/g, '');
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} preserveAspectRatio="xMidYMid meet">
      <defs>
        <clipPath id={clipId}>
          <rect x={m.l} y={m.t} width={w} height={h} />
        </clipPath>
      </defs>
      <rect x={m.l} y={m.t} width={w} height={h} className="chart-plot" />
      {yt.map((t) => (
        <g key={`y${t.label}`}>
          <line x1={m.l} x2={m.l + w} y1={py(t.v)} y2={py(t.v)} className="chart-grid" />
          <text x={m.l - 6} y={py(t.v) + 4} textAnchor="end" className="chart-tick">
            {t.label}
          </text>
        </g>
      ))}
      {xt.map((t) => (
        <g key={`x${t.label}`}>
          <line x1={px(t.v)} x2={px(t.v)} y1={m.t} y2={m.t + h} className="chart-grid" />
          <text x={px(t.v)} y={m.t + h + 16} textAnchor="middle" className="chart-tick">
            {t.label}
          </text>
        </g>
      ))}
      {hlines?.map((l) => (
        <g key={l.label}>
          <line x1={m.l} x2={m.l + w} y1={py(l.y)} y2={py(l.y)} stroke={l.color ?? 'var(--bad)'} strokeDasharray="5 4" strokeWidth={1.5} />
          <text x={m.l + w - 4} y={py(l.y) - 4} textAnchor="end" className="chart-note" fill={l.color ?? 'var(--bad)'}>
            {l.label}
          </text>
        </g>
      ))}
      {markers?.map((mk, i) => (
        <line key={i} x1={px(mk.x)} x2={px(mk.x)} y1={m.t} y2={m.t + h} stroke={mk.color ?? 'var(--bad)'} strokeWidth={1.5} strokeDasharray="3 3" />
      ))}
      {series.map((s) => (
        <path key={s.name} clipPath={`url(#${clipId})`} d={path(s)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '6 4' : undefined} strokeLinejoin="round" />
      ))}
      {xLabel && (
        <text x={m.l + w / 2} y={height - 4} textAnchor="middle" className="chart-label">
          {xLabel}
        </text>
      )}
      {yLabel && (
        <text transform={`translate(12 ${m.t + h / 2}) rotate(-90)`} textAnchor="middle" className="chart-label">
          {yLabel}
        </text>
      )}
    </svg>
  );
}

export function Legend({ items }: { items: { name: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.name}>
          <span className="swatch" style={{ background: i.dashed ? 'transparent' : i.color, borderColor: i.color }} aria-hidden="true" />
          {i.name}
        </li>
      ))}
    </ul>
  );
}
