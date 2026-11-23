import { useEffect, useRef, useState } from 'react';
import type { Cell } from '../core/bitmap';
import type { CellKind } from '../core/mux';

export type ColorMode = 'kind' | 'trib' | 'e1';

export const KIND_COLOR: Record<CellKind, string> = {
  fas: '#f59e0b',
  alarm: '#a855f7',
  national: '#a855f7',
  reserved: '#a855f7',
  cj: '#ef4444',
  stuff: '#94a3b8',
  data: '#14b8a6',
};

export const TRIB_COLOR = ['#14b8a6', '#38bdf8', '#818cf8', '#f472b6'];

export const e1Color = (src: number): string => `hsl(${Math.round((src * 137.508) % 360)} 70% 52%)`;

export function cellColor(c: Cell, mode: ColorMode): string {
  if (c.kind === 'data') {
    if (c.lowerOverhead) return mode === 'kind' ? '#64748b' : '#475569';
    if (mode === 'trib') return TRIB_COLOR[c.trib]!;
    if (mode === 'e1' && c.origin) return e1Color(c.origin.src);
    return c.carriedInS ? '#22c55e' : KIND_COLOR.data;
  }
  return KIND_COLOR[c.kind];
}

interface Props {
  cells: Cell[];
  cols: number;
  /** Rows per justification set, drawn as a separator. */
  setRows: number;
  mode: ColorMode;
  selectedE1: number | null;
  /** Indices of bits flipped by line errors. */
  errors?: Set<number> | null;
  pinned: number | null;
  onPick: (i: number | null) => void;
  onHover: (i: number | null) => void;
  label: string;
  dark: boolean;
}

export function BitMap({ cells, cols, setRows, mode, selectedE1, errors, pinned, onPick, onHover, label, dark }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(560);
  const rows = Math.ceil(cells.length / cols);
  const cell = Math.max(4, Math.floor(width / cols));
  const cw = cell * cols;
  const ch = cell * rows;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cw * dpr;
    cv.height = ch * dpr;
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const gap = cell >= 8 ? 1.5 : 1;
    for (const c of cells) {
      const x = (c.index % cols) * cell;
      const y = Math.floor(c.index / cols) * cell;
      const dim = selectedE1 !== null && !(c.origin && c.origin.src === selectedE1);
      g.globalAlpha = (c.bit ? 1 : 0.38) * (dim ? 0.18 : 1);
      g.fillStyle = cellColor(c, mode);
      g.beginPath();
      g.roundRect(x + gap / 2, y + gap / 2, cell - gap, cell - gap, cell >= 8 ? 2 : 1);
      g.fill();
      if (errors?.has(c.index)) {
        g.globalAlpha = 1;
        g.strokeStyle = '#dc2626';
        g.lineWidth = 2;
        g.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
      }
    }
    g.globalAlpha = 1;
    g.strokeStyle = dark ? '#e5ecf6' : '#0f172a';
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    for (let r = setRows; r < rows; r += setRows) {
      g.beginPath();
      g.moveTo(0, r * cell);
      g.lineTo(cw, r * cell);
      g.stroke();
    }
    g.setLineDash([]);
    if (pinned !== null) {
      const x = (pinned % cols) * cell;
      const y = Math.floor(pinned / cols) * cell;
      g.strokeStyle = dark ? '#ffffff' : '#000000';
      g.lineWidth = 2;
      g.strokeRect(x, y, cell, cell);
    }
  }, [cells, cols, cell, cw, ch, rows, setRows, mode, selectedE1, errors, pinned, dark]);

  const indexAt = (e: React.MouseEvent): number | null => {
    const r = canvas.current!.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * cols);
    const y = Math.floor(((e.clientY - r.top) / r.height) * rows);
    const i = y * cols + x;
    return x < 0 || x >= cols || y < 0 || i >= cells.length ? null : i;
  };

  return (
    <div ref={wrap} className="bitmap-wrap">
      <canvas
        ref={canvas}
        className="bitmap"
        style={{ width: cw, height: ch }}
        role="img"
        aria-label={label}
        onMouseMove={(e) => onHover(indexAt(e))}
        onMouseLeave={() => onHover(null)}
        onClick={(e) => onPick(indexAt(e))}
      />
    </div>
  );
}
