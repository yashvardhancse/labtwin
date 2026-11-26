import type { Bus } from './bus.ts';
import type { TopicMap, TopicName } from './topics.ts';

/**
 * Time-indexed store of every message of a run, grouped by topic.
 *
 * The 3D view, the charts and the run report read *only* from a RunLog, never
 * from simulator internals. A live run and a replayed MCAP file therefore go
 * through exactly the same rendering code.
 */

export interface Series<T> {
  /** Message times, ms since the start of the run, non-decreasing. */
  readonly t: readonly number[];
  readonly msgs: readonly T[];
}

interface MutableSeries {
  t: number[];
  msgs: unknown[];
}

export interface LogEntry {
  topic: string;
  t: number;
  msg: unknown;
}

const EMPTY: Series<never> = { t: [], msgs: [] };

export class RunLog {
  readonly #topics = new Map<string, MutableSeries>();
  /** Global publish order as [topic, index] pairs, for in-order export. */
  readonly #order: { topic: string; index: number }[] = [];
  #endMs = 0;

  /** Record every message published on `bus` from now on. */
  static record(bus: Bus): RunLog {
    const log = new RunLog();
    bus.subscribe((e) => {
      log.append(e.topic, e.t, e.msg);
    });
    return log;
  }

  append(topic: string, t: number, msg: unknown): void {
    let series = this.#topics.get(topic);
    if (!series) {
      series = { t: [], msgs: [] };
      this.#topics.set(topic, series);
    }
    series.t.push(t);
    series.msgs.push(msg);
    this.#order.push({ topic, index: series.t.length - 1 });
    if (t > this.#endMs) this.#endMs = t;
  }

  /** Typed access to a known topic; an empty series if nothing was published on it. */
  series<K extends TopicName>(topic: K): Series<TopicMap[K]> {
    return (this.#topics.get(topic) as Series<TopicMap[K]> | undefined) ?? EMPTY;
  }

  /** Access to any topic, including ones LabTwin does not know (e.g. `/tf` in a file). */
  raw(topic: string): Series<unknown> {
    return this.#topics.get(topic) ?? EMPTY;
  }

  get topics(): string[] {
    return [...this.#topics.keys()];
  }

  get messageCount(): number {
    return this.#order.length;
  }

  /** Time of the last message, ms. */
  get durationMs(): number {
    return this.#endMs;
  }

  /** Index of the last message on `topic` at or before `t`, or −1. */
  indexAt(topic: string, t: number): number {
    const times = this.#topics.get(topic)?.t;
    if (!times || times.length === 0 || (times[0] ?? 0) > t) return -1;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((times[mid] ?? 0) <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Latest message on `topic` at or before `t`. */
  latest<K extends TopicName>(topic: K, t: number): TopicMap[K] | undefined {
    const i = this.indexAt(topic, t);
    return i < 0 ? undefined : this.series(topic).msgs[i];
  }

  /** Every message in the order it was published. */
  *entries(): Generator<LogEntry> {
    for (const { topic, index } of this.#order) {
      const series = this.#topics.get(topic);
      if (!series) continue;
      yield { topic, t: series.t[index] ?? 0, msg: series.msgs[index] };
    }
  }

  /**
   * Sort topics whose messages arrived out of time order (possible in files
   * written by other tools); binary search needs non-decreasing times.
   */
  ensureSorted(): void {
    for (const series of this.#topics.values()) {
      const times = series.t;
      let sorted = true;
      for (let i = 1; i < times.length; i++) {
        if ((times[i] ?? 0) < (times[i - 1] ?? 0)) {
          sorted = false;
          break;
        }
      }
      if (sorted) continue;
      const idx = times.map((_, i) => i).sort((a, b) => (times[a] ?? 0) - (times[b] ?? 0));
      series.t = idx.map((i) => times[i] ?? 0);
      const msgs = series.msgs;
      series.msgs = idx.map((i) => msgs[i]);
    }
  }
}
