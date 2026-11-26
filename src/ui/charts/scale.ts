/** Chart maths: nice ticks, decimation to SVG paths, lookup at a time. */

/** Round tick values (1, 2, 2.5 or 5 × 10ⁿ apart) whose count is closest to `target`. */
export function ticks(min: number, max: number, target: number): number[] {
  if (!(max > min)) return [min];
  const power = 10 ** Math.floor(Math.log10((max - min) / Math.max(1, target)));
  let best: number[] = [];
  let bestScore = Infinity;
  for (const multiple of [1, 2, 2.5, 5, 10, 20]) {
    const step = multiple * power;
    const values: number[] = [];
    for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) {
      values.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
    }
    const score = Math.abs(values.length - target) + (values.length < 2 ? 10 : 0);
    if (score < bestScore) {
      best = values;
      bestScore = score;
    }
  }
  return best;
}

/** Round a duration up so the time axis grows in calm 5 s / 10 s jumps. */
export function niceDuration(ms: number): number {
  const step = ms <= 20_000 ? 5_000 : ms <= 60_000 ? 10_000 : 30_000;
  return Math.max(step, Math.ceil(ms / step) * step);
}

/** Index of the last sample at or before `t`, or −1. */
export function indexAt(times: readonly number[], t: number): number {
  if (times.length === 0 || (times[0] ?? 0) > t) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((times[mid] ?? 0) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Build an SVG path, decimated to at most four points per pixel column
 * (first, min, max, last), so narrow spikes — like tracking-error transients —
 * survive any amount of downsampling.
 */
export function linePath(
  t: readonly number[],
  v: readonly number[],
  x: (t: number) => number,
  y: (v: number) => number,
  step = false,
): string {
  const parts: string[] = [];
  let column = Number.NaN;
  let first = 0;
  let min = 0;
  let max = 0;
  let last = 0;
  let previousY = Number.NaN;
  const flush = () => {
    if (Number.isNaN(column)) return;
    const cx = column.toFixed(1);
    const command = parts.length === 0 ? 'M' : 'L';
    if (step && !Number.isNaN(previousY) && parts.length > 0) parts.push(`L${cx},${previousY.toFixed(1)}`);
    parts.push(`${command}${cx},${y(first).toFixed(1)}`);
    if (min !== first) parts.push(`L${cx},${y(min).toFixed(1)}`);
    if (max !== min) parts.push(`L${cx},${y(max).toFixed(1)}`);
    if (last !== max) parts.push(`L${cx},${y(last).toFixed(1)}`);
    previousY = y(last);
  };
  for (let i = 0; i < t.length; i++) {
    const value = v[i];
    const time = t[i];
    if (value === undefined || time === undefined || !Number.isFinite(value)) continue;
    const px = Math.round(x(time) * 2) / 2;
    if (px !== column) {
      flush();
      column = px;
      first = min = max = last = value;
    } else {
      if (value < min) min = value;
      if (value > max) max = value;
      last = value;
    }
  }
  flush();
  return parts.join('');
}
