import schemas from './foxglove/schemas.json' with { type: 'json' };
import {
  LINKS,
  MATERIAL_COLORS,
  PARENT,
  jointTranslations,
  machineGeometry,
  type LinkName,
  type Primitive,
} from './geometry.ts';
import type { MachineConfig, Vec3 } from './machine.ts';
import type { RunLog } from './runLog.ts';
import { extractDroplets, sceneAt, type DropletTrack } from './scene.ts';

/**
 * Foxglove adapter: derives Foxglove well-known messages from a recorded run so
 * the exported MCAP opens in Foxglove with a moving 3D machine.
 *
 *   /tf    foxglove.FrameTransforms  world → gantry_y → carriage_x → head_z (50 Hz)
 *   /scene foxglove.SceneUpdate      machine geometry per link + droplets (1 Hz + on dispense)
 *   /log   foxglove.Log              step transitions and diagnostics
 *
 * This plays the role robot_state_publisher + a URDF play in ROS 2. Foxglove
 * uses metres; LabTwin uses millimetres.
 */

export const FOXGLOVE_SCHEMAS = schemas as Record<string, Record<string, unknown>>;

export interface FoxgloveMessage {
  topic: '/tf' | '/scene' | '/log';
  schemaName: 'foxglove.FrameTransforms' | 'foxglove.SceneUpdate' | 'foxglove.Log';
  logTimeNs: bigint;
  msg: Record<string, unknown>;
}

const MM_TO_M = 0.001;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const S = Math.SQRT1_2;
/** Rotations that turn a z-aligned Foxglove cylinder onto the x or y axis. */
const CYLINDER_ORIENTATION = { x: { x: 0, y: S, z: 0, w: S }, y: { x: -S, y: 0, z: 0, w: S }, z: IDENTITY };

/** Droplets are drawn 10× their true size so a few nanolitres are visible. */
export const DROPLET_SCALE = 10;
export function dropletRadiusMm(volumeNl: number): number {
  const mm3 = volumeNl * 1e-3; // 1 nL = 0.001 mm³
  return DROPLET_SCALE * Math.cbrt((3 * mm3) / (4 * Math.PI));
}

const stamp = (ns: bigint) => ({ sec: Number(ns / 1_000_000_000n), nsec: Number(ns % 1_000_000_000n) });
/** mm → m, rounded to 0.1 µm to keep the JSON compact. */
const m = (mm: number) => Math.round(mm * MM_TO_M * 1e7) / 1e7 + 0;
const metres = (p: Vec3) => ({ x: m(p.x), y: m(p.y), z: m(p.z) });

export function frameTransforms(axes: Vec3, timeNs: bigint): Record<string, unknown> {
  const joints = jointTranslations(axes);
  return {
    transforms: (Object.keys(joints) as (keyof typeof joints)[]).map((child) => ({
      timestamp: stamp(timeNs),
      parent_frame_id: PARENT[child],
      child_frame_id: child,
      translation: metres(joints[child]),
      rotation: IDENTITY,
    })),
  };
}

function entity(
  id: string,
  frameId: string,
  timeNs: bigint,
  parts: { cubes?: unknown[]; cylinders?: unknown[]; spheres?: unknown[] },
) {
  return {
    timestamp: stamp(timeNs),
    frame_id: frameId,
    id,
    lifetime: { sec: 0, nsec: 0 },
    frame_locked: true,
    metadata: [],
    arrows: [],
    cubes: parts.cubes ?? [],
    spheres: parts.spheres ?? [],
    cylinders: parts.cylinders ?? [],
    lines: [],
    triangles: [],
    texts: [],
    models: [],
  };
}

function toPrimitive(p: Primitive) {
  const color = MATERIAL_COLORS[p.material];
  if (p.shape === 'box') {
    return { pose: { position: metres(p.center), orientation: IDENTITY }, size: metres(p.size), color };
  }
  return {
    pose: { position: metres(p.center), orientation: CYLINDER_ORIENTATION[p.axis ?? 'z'] },
    size: metres(p.size),
    bottom_scale: 1,
    top_scale: 1,
    color,
  };
}

export function sceneUpdate(
  machine: MachineConfig,
  timeNs: bigint,
  droplets: readonly { x: number; y: number; volumeNl: number }[],
): Record<string, unknown> {
  const geometry = machineGeometry(machine);
  const entities = LINKS.map((link: LinkName) => {
    const parts = geometry.filter((p) => p.link === link);
    return entity(`machine/${link}`, link, timeNs, {
      cubes: parts.filter((p) => p.shape === 'box').map(toPrimitive),
      cylinders: parts.filter((p) => p.shape === 'cylinder').map(toPrimitive),
    });
  });
  const sampleColor = MATERIAL_COLORS.sample;
  entities.push(
    entity('droplets', 'world', timeNs, {
      spheres: droplets.map((d) => {
        const r = dropletRadiusMm(d.volumeNl);
        return {
          pose: { position: metres({ x: d.x, y: d.y, z: 0.06 + r * 0.3 }), orientation: IDENTITY },
          size: metres({ x: 2 * r, y: 2 * r, z: r * 0.6 }),
          color: sampleColor,
        };
      }),
    }),
  );
  return { deletions: [], entities };
}

const LOG_LEVEL = { OK: 2, WARN: 3, ERROR: 4 } as const;

export function foxgloveMessages(
  log: RunLog,
  startTimeNs: bigint,
  machine: MachineConfig,
): FoxgloveMessage[] {
  const at = (tMs: number) => startTimeNs + BigInt(Math.round(tMs * 1e6));
  const out: FoxgloveMessage[] = [];

  // /tf at 50 Hz from the measured axis positions.
  const xs = log.series('/axis/x/state');
  for (let i = 0; i < xs.t.length; i += 2) {
    const t = xs.t[i];
    const x = xs.msgs[i];
    if (t === undefined || x === undefined) continue;
    const axes = {
      x: x.actual_mm,
      y: log.latest('/axis/y/state', t)?.actual_mm ?? machine.powerOn.y,
      z: log.latest('/axis/z/state', t)?.actual_mm ?? machine.powerOn.z,
    };
    out.push({
      topic: '/tf',
      schemaName: 'foxglove.FrameTransforms',
      logTimeNs: at(t),
      msg: frameTransforms(axes, at(t)),
    });
  }

  // /scene once a second, plus whenever a droplet finishes.
  const tracks: DropletTrack[] = extractDroplets(log);
  const sceneTimes = new Set<number>();
  for (let t = 0; t <= log.durationMs; t += 1000) sceneTimes.add(t);
  for (const track of tracks) if (track.tEnd !== null) sceneTimes.add(track.tEnd);
  sceneTimes.add(log.durationMs);
  for (const t of [...sceneTimes].sort((a, b) => a - b)) {
    const droplets = sceneAt(log, t, machine, tracks).droplets;
    out.push({
      topic: '/scene',
      schemaName: 'foxglove.SceneUpdate',
      logTimeNs: at(t),
      msg: sceneUpdate(machine, at(t), droplets),
    });
  }

  // /log from step transitions and diagnostics.
  const steps = log.series('/protocol/step');
  steps.msgs.forEach((msg, i) => {
    const t = steps.t[i] ?? 0;
    const level = msg.status === 'aborted' ? 4 : msg.status === 'canceled' ? 3 : 2;
    out.push({
      topic: '/log',
      schemaName: 'foxglove.Log',
      logTimeNs: at(t),
      msg: {
        timestamp: stamp(at(t)),
        level,
        message: `Step ${msg.index + 1} ${msg.status}: ${msg.label}`,
        name: 'protocol_executor',
        file: 'protocol.yaml',
        line: msg.line,
      },
    });
  });
  const diagnostics = log.series('/diagnostics');
  diagnostics.msgs.forEach((msg, i) => {
    const t = diagnostics.t[i] ?? 0;
    out.push({
      topic: '/log',
      schemaName: 'foxglove.Log',
      logTimeNs: at(t),
      msg: {
        timestamp: stamp(at(t)),
        level: LOG_LEVEL[msg.level],
        message: msg.message,
        name: msg.name,
        file: '',
        line: 0,
      },
    });
  });

  return out.sort((a, b) => (a.logTimeNs < b.logTimeNs ? -1 : a.logTimeNs > b.logTimeNs ? 1 : 0));
}
