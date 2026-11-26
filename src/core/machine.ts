/**
 * Machine description of the simulated nanolitre sample-prep robot: travel
 * limits, axis dynamics, pump and cryo-stage parameters and the deck layout.
 *
 * Everything the validator, the motion planner and the simulator know about the
 * hardware comes from this one object — the browser equivalent of a URDF plus
 * the controller's parameter file. Units: millimetres, seconds, nanolitres, °C.
 */

export type AxisName = 'x' | 'y' | 'z';
export const AXES: readonly AxisName[] = ['x', 'y', 'z'];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AxisConfig {
  /** Lower travel limit of the tool tip, mm. */
  min: number;
  /** Upper travel limit of the tool tip, mm. */
  max: number;
  /** Velocity limit, mm/s. */
  maxSpeed: number;
  /** Acceleration limit, mm/s². */
  maxAccel: number;
  /** Position of the axis after homing, mm. */
  home: number;
  /** Speed used while homing, mm/s. */
  homingSpeed: number;
}

export interface GridSlot {
  id: string;
  x: number;
  y: number;
}

export interface MachineConfig {
  axes: Record<AxisName, AxisConfig>;
  move: {
    /** Path speed used when a `move` step gives no `speed`, mm/s. */
    defaultSpeed: number;
    /** Largest path speed a protocol may request, mm/s. */
    maxSpeed: number;
  };
  /** Axis drive model: velocity feed-forward + P position loop + first-order drive lag. */
  servo: {
    /** Position loop gain, 1/s. */
    kp: number;
    /** Drive/motor lag time constant, s. */
    tauS: number;
    /** Encoder noise (1 σ), mm. */
    noiseMm: number;
    /** A move is finished once every axis is this close to its command, mm. */
    inPositionMm: number;
    /** Servo cycles per simulator tick (10 ms tick / 10 = 1 kHz, like an EtherCAT cycle). */
    substeps: number;
  };
  pump: {
    capacityNl: number;
    minVolumeNl: number;
    maxVolumeNl: number;
    defaultRateNlS: number;
    minRateNlS: number;
    maxRateNlS: number;
  };
  stage: {
    ambientC: number;
    minC: number;
    maxC: number;
    /** Grids must be at or below this temperature before sample is dispensed. */
    coldEnoughC: number;
    /** The stage counts as "at target" within ± this band. */
    toleranceC: number;
    /** Time constant of the exponential cooling curve, s (compressed for the demo). */
    tauS: number;
    noiseC: number;
    /** A dispense gives up if the stage is not cold after this long, s. */
    maxWaitS: number;
  };
  deck: {
    grids: GridSlot[];
    /** Radius of an EM grid (3.05 mm diameter), mm. */
    gridRadius: number;
    /** The tip must be this close to a grid centre for a dispense to land on it, mm. */
    gridHitRadius: number;
    vial: { x: number; y: number; radius: number; liquidZ: number; rimZ: number };
    /** Height of the grid plane (Z = 0) above the deck plate, mm. */
    gridPlaneHeight: number;
  };
  safety: {
    /** Below this tip height a move counts as an approach to the sample, mm. */
    approachZ: number;
    /** Approaches faster than this trigger a warning, mm/s. */
    approachMaxSpeed: number;
    /** Dispensing from higher than this lets the droplet fall, mm. */
    maxDispenseHeight: number;
    /** A protocol should leave the tip at least this high when it ends, mm. */
    retractZ: number;
  };
  wait: { maxMs: number };
  /** Where the (un-referenced) axes are when the machine is switched on. */
  powerOn: Vec3;
}

export const DEFAULT_MACHINE: MachineConfig = {
  axes: {
    x: { min: 0, max: 120, maxSpeed: 100, maxAccel: 600, home: 0, homingSpeed: 40 },
    y: { min: 0, max: 80, maxSpeed: 100, maxAccel: 600, home: 0, homingSpeed: 40 },
    z: { min: 0, max: 40, maxSpeed: 40, maxAccel: 400, home: 40, homingSpeed: 25 },
  },
  move: { defaultSpeed: 20, maxSpeed: 100 },
  servo: { kp: 120, tauS: 0.008, noiseMm: 0.0015, inPositionMm: 0.002, substeps: 10 },
  pump: {
    capacityNl: 10,
    minVolumeNl: 1,
    maxVolumeNl: 10,
    defaultRateNlS: 2,
    minRateNlS: 0.5,
    maxRateNlS: 5,
  },
  stage: {
    ambientC: 22,
    minC: -190,
    maxC: 30,
    coldEnoughC: -150,
    toleranceC: 2,
    tauS: 1.8,
    noiseC: 0.04,
    maxWaitS: 60,
  },
  deck: {
    grids: [
      { id: 'G1', x: 40, y: 25 },
      { id: 'G2', x: 50, y: 25 },
      { id: 'G3', x: 60, y: 25 },
      { id: 'G4', x: 70, y: 25 },
    ],
    gridRadius: 1.525,
    gridHitRadius: 1.2,
    vial: { x: 100, y: 60, radius: 4, liquidZ: 6, rimZ: 12 },
    gridPlaneHeight: 22,
  },
  safety: { approachZ: 5, approachMaxSpeed: 15, maxDispenseHeight: 5, retractZ: 10 },
  wait: { maxMs: 600_000 },
  powerOn: { x: 64, y: 46, z: 22 },
};

export function homePosition(machine: MachineConfig): Vec3 {
  return { x: machine.axes.x.home, y: machine.axes.y.home, z: machine.axes.z.home };
}

/** Grid slot whose centre is within `gridHitRadius` of (x, y), if any. */
export function gridAt(machine: MachineConfig, x: number, y: number): GridSlot | undefined {
  const r = machine.deck.gridHitRadius;
  return machine.deck.grids.find((g) => (g.x - x) ** 2 + (g.y - y) ** 2 <= r * r);
}

/** True when the tip at `p` is inside the sample vial, below the liquid surface. */
export function tipInVial(machine: MachineConfig, p: Vec3): boolean {
  const v = machine.deck.vial;
  const inside = (p.x - v.x) ** 2 + (p.y - v.y) ** 2 <= (v.radius - 0.5) ** 2;
  return inside && p.z <= v.liquidZ;
}
