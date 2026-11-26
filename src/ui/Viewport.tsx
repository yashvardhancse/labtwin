import { Component, useEffect, useRef, type ReactNode } from 'react';
import { DEFAULT_MACHINE, type Vec3 } from '../core/machine.ts';
import type { RunLog } from '../core/runLog.ts';
import { extractDroplets, initialScene, sceneAt, type DropletTrack } from '../core/scene.ts';
import { MachineView } from '../three/MachineView.ts';
import type { TwinController } from './controller.ts';
import { fixed } from './format.ts';
import { useController, usePrefersReducedMotion, useScene, useTwinState } from './hooks.ts';
import { PlayIcon, ResetViewIcon, SnowIcon } from './icons.tsx';

interface Props {
  plannedPath: readonly Vec3[];
  onRunDemo: () => void;
  canRun: boolean;
}

/** The hero: 3D machine, live readouts, status and the tip-camera inset. */
export function Viewport({ plannedPath, onRunDemo, canRun }: Props) {
  const { mode } = useTwinState();
  return (
    <section className="viewport" aria-label="3D view of the machine">
      <ViewportErrorBoundary>
        <MachineCanvas plannedPath={plannedPath} />
      </ViewportErrorBoundary>
      <Readouts />
      <StatusChip />
      {mode === 'idle' && canRun && (
        <button type="button" className="btn primary run-demo" onClick={onRunDemo}>
          <PlayIcon /> Run demo
        </button>
      )}
    </section>
  );
}

function MachineCanvas({ plannedPath }: { plannedPath: readonly Vec3[] }) {
  const controller = useController();
  const reducedMotion = usePrefersReducedMotion();
  const hostRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MachineView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Throws WebGLUnavailableError → caught by ViewportErrorBoundary.
    const view = new MachineView(host, DEFAULT_MACHINE, { reducedMotion, insetElement: insetRef.current });
    viewRef.current = view;
    const update = frameUpdater(controller, view);
    const offFrame = controller.subscribeFrame(update);
    const offState = controller.subscribe(update);
    update();
    return () => {
      offFrame();
      offState();
      view.dispose();
      viewRef.current = null;
    };
  }, [controller, reducedMotion]);

  useEffect(() => {
    viewRef.current?.setPlannedPath(plannedPath);
  }, [plannedPath]);

  return (
    <>
      <div className="canvas-host" ref={hostRef} />
      <div className="tip-camera" ref={insetRef}>
        <span>Tip camera</span>
      </div>
      <button
        type="button"
        className="icon-btn reset-view"
        onClick={() => viewRef.current?.resetView()}
        title="Reset the camera"
      >
        <ResetViewIcon />
        <span className="sr-only">Reset the camera</span>
      </button>
      <p className="orbit-hint" aria-hidden="true">
        Drag to orbit · scroll or pinch to zoom
      </p>
    </>
  );
}

/**
 * Per-frame scene updates outside React: derive the snapshot at the playhead
 * from the recorded log and pose the three.js scene. Droplet tracks and the
 * tool-tip trail are cached per log and extended as the log grows.
 */
function frameUpdater(controller: TwinController, view: MachineView): () => void {
  let log: RunLog | null = null;
  let tracks: DropletTrack[] = [];
  let tracksRevision = -1;
  const trail = { times: [] as number[], points: new Float32Array(12_000 * 3), count: 0, consumed: 0 };

  return () => {
    const session = controller.getState().session;
    const frame = controller.getFrame();
    if ((session?.log ?? null) !== log) {
      log = session?.log ?? null;
      tracksRevision = -1;
      trail.times = [];
      trail.count = 0;
      trail.consumed = 0;
    }
    if (!log) {
      view.setScene(initialScene(DEFAULT_MACHINE));
      view.setTrail(trail.points, 0);
      return;
    }
    if (tracksRevision !== frame.revision) {
      tracks = extractDroplets(log);
      tracksRevision = frame.revision;
    }
    view.setScene(sceneAt(log, frame.t, DEFAULT_MACHINE, tracks));

    // Extend the trail with every 5th axis sample (20 Hz) not yet consumed.
    const xs = log.series('/axis/x/state');
    for (; trail.consumed < xs.t.length; trail.consumed++) {
      if (trail.consumed % 5 !== 0 || trail.count >= 12_000) continue;
      const t = xs.t[trail.consumed] ?? 0;
      const x = xs.msgs[trail.consumed]?.actual_mm ?? 0;
      const y = log.latest('/axis/y/state', t)?.actual_mm ?? 0;
      const z = log.latest('/axis/z/state', t)?.actual_mm ?? 0;
      trail.points.set([x, y, z], trail.count * 3);
      trail.times.push(t);
      trail.count++;
    }
    let visible = trail.count;
    while (visible > 0 && (trail.times[visible - 1] ?? 0) > frame.t) visible--;
    view.setTrail(trail.points, visible);
  };
}

function Readouts() {
  const scene = useScene();
  const cold = scene.stage.celsius < -100;
  const rows = [
    ['X', scene.axes.x],
    ['Y', scene.axes.y],
    ['Z', scene.axes.z],
  ] as const;
  return (
    <dl className="readouts" aria-label="Live machine state">
      {rows.map(([name, axis]) => (
        <div key={name} className="readout">
          <dt>
            <span className={`axis-dot axis-${name.toLowerCase()}`} aria-hidden="true" />
            {name}
          </dt>
          <dd>
            <span className="num">{fixed(axis.actual, 3)}</span>
            <span className="unit">mm</span>
          </dd>
        </div>
      ))}
      <div className={`readout ${cold ? 'is-cold' : ''}`}>
        <dt>
          <SnowIcon className="readout-icon" />
          Stage
        </dt>
        <dd>
          <span className="num">{fixed(scene.stage.celsius, 1)}</span>
          <span className="unit">°C</span>
          <span className="sub">set {fixed(scene.stage.target_c, 0)}</span>
        </dd>
      </div>
      <div className="readout">
        <dt>Syringe</dt>
        <dd>
          <span className="num">{fixed(scene.pump.volume_nl, 2)}</span>
          <span className="unit">nL</span>
          {scene.pump.mode !== 'idle' && <span className="sub">{scene.pump.mode}</span>}
        </dd>
      </div>
    </dl>
  );
}

function StatusChip() {
  const { mode, playing, session, outcome } = useTwinState();
  const scene = useScene();
  let text = 'Idle · not homed';
  let tone = 'neutral';
  if (mode === 'live') {
    const step = scene.step;
    text = step ? `Step ${step.index + 1} of ${session?.stepsTotal ?? '?'} · ${step.label}` : 'Starting…';
    tone = playing ? 'live' : 'paused';
    if (!playing) text = `Paused · ${text}`;
  } else if (mode === 'review' && session) {
    const source =
      session.source === 'file' ? `Replay of ${session.fileName ?? 'recording'}` : 'Recorded run';
    const result = outcome === 'succeeded' ? 'completed' : outcome === 'canceled' ? 'stopped' : outcome;
    text = `${source}${result ? ` · ${result}` : ''}`;
    tone = outcome === 'aborted' ? 'error' : outcome === 'canceled' ? 'warn' : 'review';
  }
  return (
    <p className={`status-chip tone-${tone}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      {text}
    </p>
  );
}

class ViewportErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="viewport-fallback" role="note">
          <strong>The 3D view needs WebGL, which this browser has turned off.</strong>
          <span>
            Validation, the simulator, charts and MCAP recordings all still work. Try another browser or
            enable hardware acceleration to see the machine.
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}
