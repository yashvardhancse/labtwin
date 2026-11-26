import { readRecording, writeRecording, RecordingError, type RecordingMeta } from '../core/mcap.ts';
import type { Protocol } from '../core/protocol.ts';
import { RunLog } from '../core/runLog.ts';
import { Simulation } from '../core/sim.ts';

/**
 * Run/replay state machine for the UI, driven by requestAnimationFrame.
 *
 *   idle ──run──▶ live (running ⇄ paused) ──finish/stop──▶ review ◀──open file
 *
 * Everything the UI renders comes from `session.log`; the controller only
 * decides how far the playhead has advanced. React subscribes through two
 * channels: `state` (rare changes: mode, speed, session) and `frame` (the
 * playhead, every animation frame), so per-frame updates stay cheap.
 */

export type Speed = 1 | 2 | 5;
export const SPEEDS: readonly Speed[] = [1, 2, 5];

export interface Session {
  id: number;
  source: 'live' | 'file';
  /** Protocol name. */
  title: string;
  fileName: string | null;
  log: RunLog;
  protocolYaml: string;
  stepsTotal: number | null;
  seed: number | null;
  startTimeNs: bigint;
  simDtMs: number;
  notes: string[];
}

export interface ControllerState {
  mode: 'idle' | 'live' | 'review';
  /** live: the simulation is advancing; review: playback is running. */
  playing: boolean;
  speed: Speed;
  session: Session | null;
  /** Outcome of the live run once it ended: succeeded / aborted / canceled. */
  outcome: string | null;
}

export interface FrameState {
  /** Playhead, ms since the start of the run. */
  t: number;
  /** Duration of what has been recorded so far, ms. */
  duration: number;
  /** Grows with the log; lets consumers cache per log revision. */
  revision: number;
}

type Listener = () => void;

export class TwinController {
  #state: ControllerState = { mode: 'idle', playing: false, speed: 1, session: null, outcome: null };
  #frame: FrameState = { t: 0, duration: 0, revision: 0 };
  readonly #stateListeners = new Set<Listener>();
  readonly #frameListeners = new Set<Listener>();
  #sim: Simulation | null = null;
  #raf = 0;
  #lastNow = 0;
  #nextId = 1;

  // ── subscriptions (useSyncExternalStore) ─────────────────────────
  getState = (): ControllerState => this.#state;
  getFrame = (): FrameState => this.#frame;
  subscribe = (listener: Listener): (() => void) => {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  };
  subscribeFrame = (listener: Listener): (() => void) => {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  };

  // ── live runs ────────────────────────────────────────────────────
  startRun(protocol: Protocol, seed: number, speed?: Speed): void {
    this.#stopLoop();
    const sim = new Simulation(protocol, { seed });
    const log = RunLog.record(sim.bus);
    sim.start();
    this.#sim = sim;
    const session: Session = {
      id: this.#nextId++,
      source: 'live',
      title: protocol.name,
      fileName: null,
      log,
      protocolYaml: protocol.source,
      stepsTotal: protocol.steps.length,
      seed,
      startTimeNs: BigInt(Date.now()) * 1_000_000n,
      simDtMs: sim.dtMs,
      notes: [],
    };
    this.#setState({
      mode: 'live',
      playing: true,
      session,
      outcome: null,
      speed: speed ?? this.#state.speed,
    });
    this.#setFrame(0);
    this.#startLoop();
  }

  /** Operator stop: the run ends here and becomes a reviewable recording. */
  stop(): void {
    if (this.#state.mode !== 'live' || !this.#sim) return;
    this.#sim.cancel();
    this.#finishLive();
  }

  // ── playback (live and review) ───────────────────────────────────
  play(): void {
    const { mode, session } = this.#state;
    if (mode === 'idle' || !session) return;
    if (mode === 'review' && this.#frame.t >= session.log.durationMs) this.#setFrame(0);
    this.#setState({ playing: true });
    this.#startLoop();
  }

  pause(): void {
    this.#setState({ playing: false });
    this.#stopLoop();
  }

  togglePlay(): void {
    if (this.#state.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: Speed): void {
    this.#setState({ speed });
  }

  seek(t: number): void {
    const session = this.#state.session;
    if (this.#state.mode !== 'review' || !session) return;
    this.#setFrame(Math.min(Math.max(0, t), session.log.durationMs));
  }

  // ── recordings ───────────────────────────────────────────────────
  /** Encode the current session as MCAP bytes. */
  async exportRecording(): Promise<{ bytes: Uint8Array; fileName: string }> {
    const session = this.#state.session;
    if (!session) throw new Error('Nothing to export yet: run a protocol first.');
    const meta: RecordingMeta = {
      protocolName: session.title,
      seed: session.seed ?? 0,
      durationMs: session.log.durationMs,
      stepCount: session.stepsTotal ?? 0,
      outcome: this.#state.outcome ?? 'unknown',
      startTimeNs: session.startTimeNs,
      simDtMs: session.simDtMs,
    };
    const bytes = await writeRecording(session.log, meta, { protocolYaml: session.protocolYaml });
    return { bytes, fileName: recordingFileName(session) };
  }

  /** Open an .mcap file for replay. Throws RecordingError with a user-facing message. */
  openRecording(bytes: Uint8Array, fileName: string): void {
    const loaded = readRecording(bytes);
    this.#showRecording(loaded, fileName);
  }

  /**
   * Round-trip the current run through MCAP in memory (write → read) and replay
   * the decoded file — proof that what you download is what you get back.
   */
  async replayViaMcap(): Promise<void> {
    const { bytes, fileName } = await this.exportRecording();
    this.#showRecording(readRecording(bytes), fileName);
  }

  closeRecording(): void {
    this.#stopLoop();
    this.#sim = null;
    this.#setState({ mode: 'idle', playing: false, session: null, outcome: null });
    this.#setFrame(0);
  }

  dispose(): void {
    this.#stopLoop();
    this.#stateListeners.clear();
    this.#frameListeners.clear();
  }

  #showRecording(loaded: ReturnType<typeof readRecording>, fileName: string): void {
    this.#stopLoop();
    this.#sim = null;
    const steps = loaded.log.series('/protocol/step');
    const session: Session = {
      id: this.#nextId++,
      source: 'file',
      title: loaded.meta.protocolName ?? fileName,
      fileName,
      log: loaded.log,
      protocolYaml: loaded.protocolYaml ?? '',
      stepsTotal:
        loaded.meta.stepCount ??
        (steps.msgs.length > 0 ? Math.max(...steps.msgs.map((m) => m.index)) + 1 : null),
      seed: loaded.meta.seed ?? null,
      startTimeNs: loaded.meta.startTimeNs ?? 0n,
      simDtMs: loaded.meta.simDtMs ?? 10,
      notes: loaded.notes,
    };
    this.#setState({ mode: 'review', playing: true, session, outcome: loaded.meta.outcome ?? null });
    this.#setFrame(0);
    this.#startLoop();
  }

  #finishLive(): void {
    const session = this.#state.session;
    const outcome = this.#sim?.executor.state ?? null;
    this.#sim = null;
    this.#stopLoop();
    this.#setState({ mode: 'review', playing: false, outcome });
    this.#setFrame(session?.log.durationMs ?? 0);
  }

  #tick = (now: number): void => {
    this.#raf = 0;
    const elapsed = Math.min(now - this.#lastNow, 100); // cap catch-up after a background tab
    this.#lastNow = now;
    const { mode, playing, speed, session } = this.#state;
    if (!playing || !session) return;

    if (mode === 'live' && this.#sim) {
      const sim = this.#sim;
      const target = sim.timeMs + elapsed * speed;
      for (let i = 0; i < 2000 && sim.timeMs < target && !sim.done; i++) sim.step();
      this.#setFrame(sim.timeMs);
      if (sim.done) {
        this.#finishLive();
        return;
      }
    } else if (mode === 'review') {
      const t = Math.min(session.log.durationMs, this.#frame.t + elapsed * speed);
      this.#setFrame(t);
      if (t >= session.log.durationMs) {
        this.#setState({ playing: false });
        return;
      }
    }
    this.#raf = requestAnimationFrame(this.#tick);
  };

  #startLoop(): void {
    if (this.#raf) return;
    this.#lastNow = performance.now();
    this.#raf = requestAnimationFrame(this.#tick);
  }

  #stopLoop(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  #setState(patch: Partial<ControllerState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#stateListeners) listener();
  }

  #setFrame(t: number): void {
    const log = this.#state.session?.log;
    this.#frame = { t, duration: log?.durationMs ?? 0, revision: log?.messageCount ?? 0 };
    for (const listener of this.#frameListeners) listener();
  }
}

export function recordingFileName(session: Session): string {
  if (session.fileName) return session.fileName;
  const slug = session.title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const stamp = new Date(Number(session.startTimeNs / 1_000_000n))
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, '-');
  return `${slug || 'run'}-${stamp}.mcap`;
}

export { RecordingError };
