import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { fixed } from '../format.ts';
import { useElementWidth } from '../hooks.ts';
import { indexAt, linePath, ticks } from './scale.ts';

export interface ChartSeries {
  id: string;
  label: string;
  color: string;
  t: readonly number[];
  v: readonly number[];
  /** line: 2px; band: wide translucent stroke (commanded); step: stepped thin line; area: line + 10% wash. */
  variant?: 'line' | 'band' | 'step' | 'area';
}

interface Props {
  label: string;
  series: ChartSeries[];
  tDomain: readonly [number, number];
  yDomain: readonly [number, number];
  height: number;
  playhead: number | null;
  fadeAfterPlayhead: boolean;
  hoverT: number | null;
  onHoverT: (t: number | null) => void;
  format: (v: number) => string;
  unit: string;
  showXAxis?: boolean;
  yTickCount?: number;
  /** Explicit y ticks (e.g. the travel limits) instead of computed ones. */
  yTickValues?: readonly number[];
  /** Small-multiple label in a gutter left of the y ticks. */
  rowLabel?: ReactNode;
}

/** Minimal SVG time-series chart: hairline grid, decimated paths, shared crosshair, tooltip. */
export function TimeSeriesChart({
  label,
  series,
  tDomain,
  yDomain,
  height,
  playhead,
  fadeAfterPlayhead,
  hoverT,
  onHoverT,
  format,
  unit,
  showXAxis = true,
  yTickCount = 3,
  yTickValues,
  rowLabel,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef);
  const [active, setActive] = useState(false);
  const M = { left: rowLabel ? 62 : 44, right: 10, top: 8 };
  const bottom = showXAxis ? 20 : 4;
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = Math.max(10, height - M.top - bottom);
  const [t0, t1] = tDomain;
  const [y0, y1] = yDomain;
  const x = (t: number) => M.left + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const y = (v: number) => M.top + (1 - (Math.min(Math.max(v, y0), y1) - y0) / (y1 - y0 || 1)) * plotH;
  const tAt = (px: number) => t0 + ((px - M.left) / plotW) * (t1 - t0);
  const clampT = (t: number) => Math.min(Math.max(t, t0), t1);

  const yTicks = yTickValues ?? ticks(y0, y1, yTickCount);
  const xTicks = showXAxis ? ticks(t0, t1, Math.max(2, Math.floor(plotW / 70))) : [];

  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box) return;
    onHoverT(clampT(tAt(e.clientX - box.left)));
  };
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = (t1 - t0) / 100;
    const current = hoverT ?? playhead ?? t0;
    if (e.key === 'ArrowRight') onHoverT(clampT(current + step));
    else if (e.key === 'ArrowLeft') onHoverT(clampT(current - step));
    else if (e.key === 'Escape') onHoverT(null);
    else return;
    e.preventDefault();
  };

  const hoverValues =
    hoverT === null
      ? []
      : series.map((s) => {
          const i = indexAt(s.t, hoverT);
          return { s, value: i >= 0 ? s.v[i] : undefined };
        });
  const showTooltip = active && hoverT !== null && width > 0;
  const tooltipLeft = hoverT === null ? 0 : x(hoverT);

  return (
    <div className="ts-chart" ref={wrapRef} style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setActive(true);
            onHoverT(playhead ?? t0);
          }}
          onBlur={() => {
            setActive(false);
            onHoverT(null);
          }}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line className="grid-line" x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} />
              <text className="tick" x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
                {fixed(v, Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="tick" x={x(t)} y={height - 5} textAnchor="middle">
              {`${(t / 1000).toFixed(t % 1000 === 0 ? 0 : 1)} s`}
            </text>
          ))}
          <line className="axis-line" x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} />

          {series.map((s) => {
            const d = linePath(s.t, s.v, x, y, s.variant === 'step');
            if (!d) return null;
            if (s.variant === 'band') {
              return <path key={s.id} d={d} className="series-band" stroke={s.color} />;
            }
            if (s.variant === 'area') {
              const lastT = s.t[s.t.length - 1] ?? t0;
              return (
                <g key={s.id}>
                  <path
                    d={`${d}L${x(lastT).toFixed(1)},${y(y0).toFixed(1)}L${x(s.t[0] ?? t0).toFixed(1)},${y(y0).toFixed(1)}Z`}
                    fill={s.color}
                    opacity={0.1}
                  />
                  <path d={d} className="series-line" stroke={s.color} />
                </g>
              );
            }
            return (
              <path
                key={s.id}
                d={d}
                className={s.variant === 'step' ? 'series-step' : 'series-line'}
                stroke={s.color}
              />
            );
          })}

          {fadeAfterPlayhead && playhead !== null && playhead < t1 && (
            <rect
              className="future-fade"
              x={x(playhead)}
              y={M.top - 2}
              width={Math.max(0, M.left + plotW - x(playhead))}
              height={plotH + 4}
            />
          )}
          {playhead !== null && (
            <line className="playhead" x1={x(playhead)} x2={x(playhead)} y1={M.top - 2} y2={M.top + plotH} />
          )}
          {hoverT !== null && (
            <line className="crosshair" x1={x(hoverT)} x2={x(hoverT)} y1={M.top} y2={M.top + plotH} />
          )}
          <rect
            className="hit-area"
            x={M.left}
            y={0}
            width={plotW}
            height={height}
            onPointerEnter={() => {
              setActive(true);
            }}
            onPointerMove={onPointerMove}
            onPointerLeave={() => {
              setActive(false);
              onHoverT(null);
            }}
          />
        </svg>
      )}
      {rowLabel && (
        <span className="row-label" style={{ top: M.top + plotH / 2 }}>
          {rowLabel}
        </span>
      )}
      {showTooltip && (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(Math.max(tooltipLeft + 10, 0), Math.max(0, width - 150)) }}
          aria-hidden="true"
        >
          <div className="tooltip-time">{`${(hoverT / 1000).toFixed(2)} s`}</div>
          {hoverValues.map(({ s, value }) => (
            <div key={s.id} className="tooltip-row">
              <span className="line-key" style={{ background: s.color }} />
              <strong>{value === undefined ? '–' : `${format(value)} ${unit}`}</strong>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
