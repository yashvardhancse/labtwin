import { useMemo, useState, type ReactNode } from 'react';
import { AXES, DEFAULT_MACHINE, type AxisName } from '../../core/machine.ts';
import type { RunLog } from '../../core/runLog.ts';
import { AXIS_TOPIC } from '../../core/topics.ts';
import { fixed } from '../format.ts';
import { useFrame, useTwinState } from '../hooks.ts';
import { AXIS_COLORS } from './colors.ts';
import { niceDuration } from './scale.ts';
import { TimeSeriesChart, type ChartSeries } from './TimeSeriesChart.tsx';

const COMMANDED = '#8fa3b5';
const MEASURED_TEMP = 'var(--cryo)';
const SETPOINT = '#7d8a96';
const VOLUME = '#4a5866';

interface ChartData {
  /** Time arrays are shared with the log (read-only); value columns are built here. */
  axes: Record<AxisName, { t: readonly number[]; cmd: number[]; actual: number[]; errorUm: number[] }>;
  temp: { t: readonly number[]; celsius: number[]; target: number[] };
  pump: { t: readonly number[]; volume: number[] };
  maxErrorUm: number;
}

/** Column arrays for the charts. `revision` keys the memo: the log grows in place. */
function chartData(log: RunLog | undefined, revision: number): ChartData {
  const empty = () => ({
    t: [] as readonly number[],
    cmd: [] as number[],
    actual: [] as number[],
    errorUm: [] as number[],
  });
  const data: ChartData = {
    axes: { x: empty(), y: empty(), z: empty() },
    temp: { t: [], celsius: [], target: [] },
    pump: { t: [], volume: [] },
    maxErrorUm: 0,
  };
  if (!log || revision < 0) return data;
  for (const axis of AXES) {
    const s = log.series(AXIS_TOPIC[axis]);
    const out = data.axes[axis];
    out.t = s.t;
    for (const msg of s.msgs) {
      out.cmd.push(msg.cmd_mm);
      out.actual.push(msg.actual_mm);
      const e = (msg.cmd_mm - msg.actual_mm) * 1000;
      out.errorUm.push(e);
      if (Math.abs(e) > data.maxErrorUm) data.maxErrorUm = Math.abs(e);
    }
  }
  const temp = log.series('/stage/temperature');
  data.temp.t = temp.t;
  for (const msg of temp.msgs) {
    data.temp.celsius.push(msg.celsius);
    data.temp.target.push(msg.target_c);
  }
  const pump = log.series('/pump/state');
  data.pump.t = pump.t;
  for (const msg of pump.msgs) data.pump.volume.push(msg.volume_nl);
  return data;
}

export function ChartsPanel() {
  const { session, mode } = useTwinState();
  const frame = useFrame();
  const [hoverT, setHoverT] = useState<number | null>(null);
  const log = session?.log;
  const data = useMemo(() => chartData(log, frame.revision), [log, frame.revision]);

  const tDomain = [0, niceDuration(frame.duration)] as const;
  const playhead = mode === 'idle' ? null : frame.t;
  const common = {
    tDomain,
    playhead,
    fadeAfterPlayhead: mode === 'review',
    hoverT,
    onHoverT: setHoverT,
  };
  const errorRange = Math.max(20, Math.ceil(data.maxErrorUm / 20) * 20);

  return (
    <section className="charts" aria-label="Telemetry charts">
      <ChartCard
        title="Axis position"
        unit="mm"
        legend={[
          { label: 'Commanded', color: COMMANDED, band: true },
          { label: 'Measured', color: 'var(--ink-2)' },
        ]}
        empty={!log}
      >
        <div className="small-multiples">
          {AXES.map((axis, i) => {
            const a = data.axes[axis];
            const limits = DEFAULT_MACHINE.axes[axis];
            return (
              <TimeSeriesChart
                key={axis}
                {...common}
                label={`${axis.toUpperCase()} axis position, commanded and measured, in millimetres`}
                rowLabel={<span className={`axis-dot axis-${axis}`}>{axis.toUpperCase()}</span>}
                series={[
                  {
                    id: `${axis}-cmd`,
                    label: 'Commanded',
                    color: AXIS_COLORS[axis],
                    t: a.t,
                    v: a.cmd,
                    variant: 'band',
                  },
                  { id: `${axis}-act`, label: 'Measured', color: AXIS_COLORS[axis], t: a.t, v: a.actual },
                ]}
                yDomain={[limits.min, limits.max]}
                yTickValues={[limits.min, limits.max]}
                height={i === AXES.length - 1 ? 62 : 44}
                showXAxis={i === AXES.length - 1}
                format={(v) => fixed(v, 3)}
                unit="mm"
              />
            );
          })}
        </div>
      </ChartCard>

      <ChartCard
        title="Tracking error"
        unit="µm"
        note="commanded − measured"
        legend={AXES.map((axis) => ({ label: axis.toUpperCase(), color: AXIS_COLORS[axis] }))}
        empty={!log}
      >
        <TimeSeriesChart
          {...common}
          label="Tracking error per axis in micrometres"
          series={AXES.map((axis): ChartSeries => ({
            id: axis,
            label: axis.toUpperCase(),
            color: AXIS_COLORS[axis],
            t: data.axes[axis].t,
            v: data.axes[axis].errorUm,
          }))}
          yDomain={[-errorRange, errorRange]}
          height={150}
          format={(v) => fixed(v, 1)}
          unit="µm"
        />
      </ChartCard>

      <ChartCard
        title="Stage temperature"
        unit="°C"
        legend={[
          { label: 'Measured', color: MEASURED_TEMP },
          { label: 'Set-point', color: SETPOINT, thin: true },
        ]}
        empty={!log}
      >
        <TimeSeriesChart
          {...common}
          label="Cryo-stage temperature and set-point in degrees Celsius"
          series={[
            {
              id: 'target',
              label: 'Set-point',
              color: SETPOINT,
              t: data.temp.t,
              v: data.temp.target,
              variant: 'step',
            },
            { id: 'temp', label: 'Measured', color: MEASURED_TEMP, t: data.temp.t, v: data.temp.celsius },
          ]}
          yDomain={[-200, 40]}
          height={150}
          format={(v) => fixed(v, 1)}
          unit="°C"
        />
      </ChartCard>

      <ChartCard title="Syringe volume" unit="nL" empty={!log}>
        <TimeSeriesChart
          {...common}
          label="Sample volume held in the syringe, in nanolitres"
          series={[
            {
              id: 'volume',
              label: 'Volume',
              color: VOLUME,
              t: data.pump.t,
              v: data.pump.volume,
              variant: 'area',
            },
          ]}
          yDomain={[0, DEFAULT_MACHINE.pump.capacityNl]}
          height={150}
          format={(v) => fixed(v, 2)}
          unit="nL"
        />
      </ChartCard>
    </section>
  );
}

interface LegendItem {
  label: string;
  color: string;
  band?: boolean;
  thin?: boolean;
}

function ChartCard({
  title,
  unit,
  note,
  legend,
  empty,
  children,
}: {
  title: string;
  unit: string;
  note?: string;
  legend?: LegendItem[];
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <figure className="chart-card">
      <figcaption>
        <span className="chart-title">
          {title} <span className="chart-unit">{unit}</span>
          {note && <span className="chart-note">{note}</span>}
        </span>
        {legend && (
          <span className="legend">
            {legend.map((item) => (
              <span key={item.label} className="legend-item">
                <span
                  className={`line-key${item.band ? ' band' : ''}${item.thin ? ' thin' : ''}`}
                  style={{ background: item.color }}
                />
                {item.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className={`chart-body${empty ? ' is-empty' : ''}`}>
        {children}
        {empty && <p className="chart-empty">Run a protocol to record telemetry.</p>}
      </div>
    </figure>
  );
}
