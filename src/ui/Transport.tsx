import { useMemo, useRef, type ChangeEvent } from 'react';
import type { RunLog } from '../core/runLog.ts';
import { SPEEDS } from './controller.ts';
import { seconds } from './format.ts';
import { useController, useFrame, useTwinState } from './hooks.ts';
import { DownloadIcon, ErrorIcon, OpenIcon, PauseIcon, PlayIcon, StopIcon } from './icons.tsx';

interface Props {
  canRun: boolean;
  errorCount: number;
  onRun: () => void;
  onDownload: () => void;
  onOpenFile: (file: File) => void;
  seed: number;
  onSeedChange: (seed: number) => void;
}

/** Run controls, playback speed, timeline with step markers and recording actions. */
export function Transport({ canRun, errorCount, onRun, onDownload, onOpenFile, seed, onSeedChange }: Props) {
  const controller = useController();
  const { mode, playing, speed, session } = useTwinState();
  const fileRef = useRef<HTMLInputElement>(null);
  const live = mode === 'live';
  const runHint = errorCount > 0 ? `Fix ${errorCount} error${errorCount === 1 ? '' : 's'} to run` : undefined;
  const downloadHint =
    session?.source === 'file'
      ? 'This recording was opened from a file'
      : mode === 'review'
        ? undefined
        : 'Available once a run has finished';

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onOpenFile(file);
    e.target.value = '';
  };

  return (
    <div className="transport">
      <Timeline />
      <div className="transport-row" role="toolbar" aria-label="Run and replay controls">
        <div className="group">
          <button
            type="button"
            className="btn primary"
            onClick={onRun}
            disabled={!canRun || live}
            aria-describedby={runHint ? 'run-hint' : undefined}
          >
            <PlayIcon /> {live ? 'Running…' : mode === 'review' ? 'Run again' : 'Run protocol'}
          </button>
          {runHint && !live && (
            <span id="run-hint" className="run-hint">
              <ErrorIcon /> {runHint}
            </span>
          )}
          {mode !== 'idle' && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                controller.togglePlay();
              }}
              aria-label={
                playing
                  ? live
                    ? 'Pause the run'
                    : 'Pause the replay'
                  : live
                    ? 'Resume the run'
                    : 'Play the replay'
              }
              title={playing ? 'Pause' : live ? 'Resume' : 'Play'}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
          )}
          {live && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                controller.stop();
              }}
              aria-label="Stop the run"
              title="Stop"
            >
              <StopIcon />
            </button>
          )}
          <fieldset className="segmented" aria-label="Simulation speed">
            <legend className="sr-only">Speed</legend>
            {SPEEDS.map((s) => (
              <label key={s} className={s === speed ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="speed"
                  value={s}
                  checked={s === speed}
                  onChange={() => {
                    controller.setSpeed(s);
                  }}
                />
                {s}×
              </label>
            ))}
          </fieldset>
          <label className="seed">
            Seed
            <input
              type="number"
              min={0}
              max={4294967295}
              value={seed}
              disabled={live}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isInteger(value) && value >= 0) onSeedChange(value);
              }}
            />
          </label>
          <TimeReadout />
        </div>
        <div className="group recording-actions">
          <button
            type="button"
            className="btn"
            onClick={onDownload}
            disabled={mode !== 'review' || session?.source !== 'live'}
            title={downloadHint}
          >
            <DownloadIcon /> Download recording (.mcap)
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={live}>
            <OpenIcon /> Open recording
          </button>
          <input ref={fileRef} type="file" accept=".mcap" hidden onChange={onFile} />
        </div>
      </div>
    </div>
  );
}

function TimeReadout() {
  const frame = useFrame();
  const { mode } = useTwinState();
  if (mode === 'idle') return <span className="time-readout num">0.00 s</span>;
  if (mode === 'live') return <span className="time-readout num">{seconds(frame.t)}</span>;
  return (
    <span className="time-readout num">
      {seconds(frame.t)} <span className="of">/ {seconds(frame.duration)}</span>
    </span>
  );
}

interface StepMarker {
  index: number;
  label: string;
  type: string;
  start: number;
  end: number;
}

/** Step segments from `/protocol/step` transitions; `revision` keys the memo as the log grows. */
function stepMarkers(log: RunLog | undefined, revision: number, now: number): StepMarker[] {
  if (!log || revision < 0) return [];
  const steps = log.series('/protocol/step');
  const markers: StepMarker[] = [];
  steps.msgs.forEach((msg, i) => {
    const t = steps.t[i] ?? 0;
    if (msg.status === 'executing') {
      markers.push({ index: msg.index, label: msg.label, type: msg.type, start: t, end: now });
    } else {
      const open = markers.findLast((m) => m.index === msg.index);
      if (open) open.end = t;
    }
  });
  return markers;
}

function Timeline() {
  const controller = useController();
  const { mode, session } = useTwinState();
  const frame = useFrame();
  const duration = Math.max(frame.duration, 1);
  const markers = useMemo(
    () => stepMarkers(session?.log, frame.revision, frame.duration),
    [session, frame.revision, frame.duration],
  );
  const seekable = mode === 'review';
  const pct = (t: number) => `${(Math.min(t, duration) / duration) * 100}%`;

  return (
    <div className={`timeline${seekable ? ' is-seekable' : ''}`}>
      <div className="timeline-track" aria-hidden="true">
        {markers.map((m, i) => (
          <span
            key={i}
            className={`step-band type-${m.type}`}
            style={{ left: pct(m.start), width: `calc(${pct(m.end)} - ${pct(m.start)})` }}
            title={`Step ${m.index + 1}: ${m.label}`}
          />
        ))}
        <span className="timeline-progress" style={{ width: mode === 'idle' ? 0 : pct(frame.t) }} />
      </div>
      <input
        type="range"
        className="timeline-input"
        min={0}
        max={Math.round(duration)}
        step={10}
        value={Math.round(Math.min(frame.t, duration))}
        disabled={!seekable}
        aria-label="Playhead position"
        aria-valuetext={`${seconds(frame.t)} of ${seconds(frame.duration)}`}
        onChange={(e) => {
          controller.seek(Number(e.target.value));
        }}
        onPointerDown={() => {
          if (seekable) controller.pause();
        }}
      />
    </div>
  );
}
