import { AXES, type AxisName, type MachineConfig } from './machine.ts';
import type { RunLog } from './runLog.ts';
import { AXIS_TOPIC, type ProtocolStepMsg, type PumpStateMsg, type StageTemperatureMsg } from './topics.ts';

/**
 * Snapshot of everything the 3D view needs at one instant, derived purely from
 * recorded topics. Live runs and replays both go through `sceneAt()`.
 */

export interface AxisSnapshot {
  cmd: number;
  actual: number;
  velocity: number;
  homed: boolean;
}

export interface Droplet {
  id: number;
  x: number;
  y: number;
  volumeNl: number;
  /** Still being dispensed at this instant. */
  growing: boolean;
}

export interface SceneState {
  t: number;
  axes: Record<AxisName, AxisSnapshot>;
  pump: PumpStateMsg;
  stage: StageTemperatureMsg;
  /** Latest step transition at or before `t`. */
  step: ProtocolStepMsg | null;
  droplets: Droplet[];
}

/** One dispense, reconstructed from `/pump/state` mode changes and the tip position. */
export interface DropletTrack {
  id: number;
  tStart: number;
  /** null while the dispense is still running at the end of the log. */
  tEnd: number | null;
  x: number;
  y: number;
  /** Syringe volume just before the dispense started, nL. */
  startVolume: number;
  endVolume: number | null;
}

export function initialScene(machine: MachineConfig): SceneState {
  const axes = {} as Record<AxisName, AxisSnapshot>;
  for (const axis of AXES) {
    const p = machine.powerOn[axis];
    axes[axis] = { cmd: p, actual: p, velocity: 0, homed: false };
  }
  return {
    t: 0,
    axes,
    pump: { volume_nl: 0, flow_nl_s: 0, mode: 'idle' },
    stage: { celsius: machine.stage.ambientC, target_c: machine.stage.ambientC },
    step: null,
    droplets: [],
  };
}

export function extractDroplets(log: RunLog): DropletTrack[] {
  const pump = log.series('/pump/state');
  const tracks: DropletTrack[] = [];
  let open: DropletTrack | null = null;
  let previousVolume = 0;
  for (let i = 0; i < pump.t.length; i++) {
    const msg = pump.msgs[i];
    const t = pump.t[i];
    if (msg === undefined || t === undefined) continue;
    if (msg.mode === 'dispensing' && open === null) {
      open = {
        id: tracks.length,
        tStart: t,
        tEnd: null,
        x: log.latest('/axis/x/state', t)?.actual_mm ?? 0,
        y: log.latest('/axis/y/state', t)?.actual_mm ?? 0,
        startVolume: previousVolume,
        endVolume: null,
      };
      tracks.push(open);
    } else if (msg.mode !== 'dispensing' && open !== null) {
      open.tEnd = t;
      open.endVolume = msg.volume_nl;
      open = null;
    }
    previousVolume = msg.volume_nl;
  }
  return tracks;
}

export function sceneAt(
  log: RunLog,
  t: number,
  machine: MachineConfig,
  tracks: readonly DropletTrack[],
): SceneState {
  const base = initialScene(machine);
  for (const axis of AXES) {
    const msg = log.latest(AXIS_TOPIC[axis], t);
    if (msg) {
      base.axes[axis] = {
        cmd: msg.cmd_mm,
        actual: msg.actual_mm,
        velocity: msg.velocity_mm_s,
        homed: msg.homed,
      };
    }
  }
  const pump = log.latest('/pump/state', t);
  const stage = log.latest('/stage/temperature', t);
  const droplets: Droplet[] = [];
  for (const track of tracks) {
    if (track.tStart > t) break;
    const ended = track.tEnd !== null && t >= track.tEnd;
    const volumeNow = ended ? (track.endVolume ?? 0) : (pump?.volume_nl ?? track.startVolume);
    droplets.push({
      id: track.id,
      x: track.x,
      y: track.y,
      volumeNl: Math.max(0, track.startVolume - volumeNow),
      growing: !ended,
    });
  }
  return {
    t,
    axes: base.axes,
    pump: pump ?? base.pump,
    stage: stage ?? base.stage,
    step: log.latest('/protocol/step', t) ?? null,
    droplets,
  };
}
