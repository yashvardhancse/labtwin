import { useMemo } from 'react';
import { AXES } from '../core/machine.ts';
import { summarizeRun, type RunReport as Report } from '../core/report.ts';
import type { RunLog } from '../core/runLog.ts';
import { AXIS_COLORS } from './charts/colors.ts';
import { fixed, plural, seconds } from './format.ts';
import { useFrame, useTwinState } from './hooks.ts';
import { CheckIcon, ErrorIcon, WarningIcon } from './icons.tsx';

/** Report bucket: recompute a few times a second while live, not every frame. */
function report(log: RunLog | undefined, stepsTotal: number | null, bucket: number): Report | null {
  return log && bucket >= 0 ? summarizeRun(log, stepsTotal) : null;
}

export function RunReport({ onReplayViaMcap }: { onReplayViaMcap: () => void }) {
  const { session, mode } = useTwinState();
  const frame = useFrame();
  const bucket = mode === 'live' ? Math.floor(frame.revision / 400) : frame.revision;
  const r = useMemo(() => report(session?.log, session?.stepsTotal ?? null, bucket), [session, bucket]);

  if (!session || !r) {
    return (
      <section className="report" aria-labelledby="report-title">
        <h2 id="report-title" className="panel-title">
          Run report
        </h2>
        <p className="report-empty">
          Run a protocol to see its duration, the steps completed, the tracking error per axis and any
          warnings. Every run is recorded and can be downloaded as an MCAP file.
        </p>
      </section>
    );
  }

  const outcome = outcomeLabel(r.outcome);
  const maxError = Math.max(1, ...AXES.map((a) => r.tracking[a].maxUm));
  return (
    <section className="report" aria-labelledby="report-title">
      <div className="report-head">
        <h2 id="report-title" className="panel-title">
          Run report
        </h2>
        <span className={`badge badge-${outcome.tone}`}>
          {outcome.tone === 'ok' && <CheckIcon />}
          {outcome.tone === 'warn' && <WarningIcon />}
          {outcome.tone === 'error' && <ErrorIcon />}
          {outcome.text}
        </span>
      </div>
      <p className="report-sub">
        {session.title}
        {session.seed !== null && <> · seed {session.seed}</>}
        {session.source === 'file' && <> · from {session.fileName}</>}
      </p>

      <dl className="report-grid">
        <div>
          <dt>Duration</dt>
          <dd className="num">{seconds(r.durationMs)}</dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd className="num">
            {r.stepsSucceeded} of {r.stepsTotal ?? '?'}
          </dd>
        </div>
        <div>
          <dt>Stage minimum</dt>
          <dd className="num">{r.stage.minC === null ? '–' : `${fixed(r.stage.minC, 1)} °C`}</dd>
        </div>
        <div>
          <dt>Droplets</dt>
          <dd className="num">{r.droplets}</dd>
        </div>
        <div>
          <dt>Aspirated</dt>
          <dd className="num">{fixed(r.pump.aspiratedNl, 1)} nL</dd>
        </div>
        <div>
          <dt>Dispensed</dt>
          <dd className="num">{fixed(r.pump.dispensedNl, 1)} nL</dd>
        </div>
      </dl>

      <div className="report-tracking">
        <h3>Max tracking error</h3>
        <ul>
          {AXES.map((axis) => (
            <li key={axis}>
              <span className="axis-name">{axis.toUpperCase()}</span>
              <span className="meter" aria-hidden="true">
                <span
                  style={{
                    width: `${(r.tracking[axis].maxUm / maxError) * 100}%`,
                    background: AXIS_COLORS[axis],
                  }}
                />
              </span>
              <span className="num">{fixed(r.tracking[axis].maxUm, 1)} µm</span>
            </li>
          ))}
        </ul>
      </div>

      {r.issues.length > 0 && (
        <ul className="report-issues" aria-label="Warnings and errors">
          {r.issues.map((issue, i) => (
            <li key={i} className={issue.level === 'ERROR' ? 'is-error' : 'is-warning'}>
              {issue.level === 'ERROR' ? <ErrorIcon /> : <WarningIcon />}
              <span>
                <span className="num">{seconds(issue.t, 1)}</span> {issue.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="report-recording">
        Recorded {r.messageCount.toLocaleString('en')} messages on {plural(r.topicCount, 'topic')}.
        {mode === 'review' && session.source === 'live' && (
          <>
            {' '}
            <button type="button" className="link-btn" onClick={onReplayViaMcap}>
              Replay it from MCAP
            </button>
          </>
        )}
      </p>
      {session.notes.length > 0 && (
        <ul className="report-notes">
          {session.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function outcomeLabel(outcome: Report['outcome']): { text: string; tone: 'ok' | 'warn' | 'error' | 'live' } {
  switch (outcome) {
    case 'succeeded':
      return { text: 'Completed', tone: 'ok' };
    case 'canceled':
      return { text: 'Stopped', tone: 'warn' };
    case 'aborted':
      return { text: 'Aborted', tone: 'error' };
    case 'running':
      return { text: 'Running', tone: 'live' };
  }
}
