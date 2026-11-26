import { AXES, type AxisName } from './machine.ts';
import type { RunLog } from './runLog.ts';
import { extractDroplets } from './scene.ts';
import { AXIS_TOPIC, type DiagnosticLevel } from './topics.ts';

export type RunOutcome = 'succeeded' | 'aborted' | 'canceled' | 'running';

export interface TrackingStats {
  /** Largest |commanded − measured|, µm. */
  maxUm: number;
  /** RMS following error while the axis is moving, µm. */
  rmsMovingUm: number;
}

export interface RunIssue {
  t: number;
  level: DiagnosticLevel;
  name: string;
  message: string;
}

export interface RunReport {
  durationMs: number;
  outcome: RunOutcome;
  stepsSucceeded: number;
  stepsTotal: number | null;
  /** The step that was aborted or canceled, if any. */
  stoppedAt: { index: number; label: string } | null;
  tracking: Record<AxisName, TrackingStats>;
  stage: { minC: number | null; finalC: number | null };
  pump: { aspiratedNl: number; dispensedNl: number; remainingNl: number };
  droplets: number;
  /** WARN and ERROR diagnostics, in time order. */
  issues: RunIssue[];
  messageCount: number;
  topicCount: number;
}

/** Summarise a run (live or replayed) from its recorded topics alone. */
export function summarizeRun(log: RunLog, stepsTotal: number | null): RunReport {
  const steps = log.series('/protocol/step');
  let stepsSucceeded = 0;
  let outcome: RunOutcome = 'running';
  let stoppedAt: RunReport['stoppedAt'] = null;
  for (const msg of steps.msgs) {
    if (msg.status === 'succeeded') stepsSucceeded++;
    if (msg.status === 'aborted' || msg.status === 'canceled') {
      outcome = msg.status;
      stoppedAt = { index: msg.index, label: msg.label };
    }
  }
  const diagnostics = log.series('/diagnostics');
  const issues: RunIssue[] = [];
  diagnostics.msgs.forEach((msg, i) => {
    if (msg.level !== 'OK') issues.push({ t: diagnostics.t[i] ?? 0, ...msg });
    if (outcome === 'running' && msg.level === 'ERROR') outcome = 'aborted';
    if (outcome === 'running' && msg.level === 'WARN' && msg.message.includes('stopped by the operator')) {
      outcome = 'canceled';
    }
  });
  if (outcome === 'running' && stepsTotal !== null && stepsSucceeded >= stepsTotal && stepsTotal > 0) {
    outcome = 'succeeded';
  }

  const tracking = {} as Record<AxisName, TrackingStats>;
  for (const axis of AXES) {
    let max = 0;
    let sumSq = 0;
    let moving = 0;
    for (const msg of log.series(AXIS_TOPIC[axis]).msgs) {
      const errorUm = Math.abs(msg.cmd_mm - msg.actual_mm) * 1000;
      if (errorUm > max) max = errorUm;
      if (Math.abs(msg.velocity_mm_s) > 0.5) {
        sumSq += errorUm * errorUm;
        moving++;
      }
    }
    tracking[axis] = { maxUm: max, rmsMovingUm: moving > 0 ? Math.sqrt(sumSq / moving) : 0 };
  }

  const temps = log.series('/stage/temperature').msgs;
  let minC: number | null = null;
  for (const msg of temps) if (minC === null || msg.celsius < minC) minC = msg.celsius;

  const pumpMsgs = log.series('/pump/state').msgs;
  let aspiratedNl = 0;
  let dispensedNl = 0;
  for (let i = 1; i < pumpMsgs.length; i++) {
    const delta = (pumpMsgs[i]?.volume_nl ?? 0) - (pumpMsgs[i - 1]?.volume_nl ?? 0);
    if (delta > 0) aspiratedNl += delta;
    else dispensedNl -= delta;
  }

  return {
    durationMs: log.durationMs,
    outcome,
    stepsSucceeded,
    stepsTotal,
    stoppedAt,
    tracking,
    stage: { minC, finalC: temps[temps.length - 1]?.celsius ?? null },
    pump: {
      aspiratedNl: Math.round(aspiratedNl * 1000) / 1000,
      dispensedNl: Math.round(dispensedNl * 1000) / 1000,
      remainingNl: pumpMsgs[pumpMsgs.length - 1]?.volume_nl ?? 0,
    },
    droplets: extractDroplets(log).length,
    issues,
    messageCount: log.messageCount,
    topicCount: log.topics.length,
  };
}
