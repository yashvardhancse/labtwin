import { AXES, type AxisConfig, type AxisName, type Vec3 } from './machine.ts';
import { planSCurve, sampleSCurve, type SCurveProfile } from './scurve.ts';

/**
 * Trapezoidal velocity profiles: accelerate at a constant rate, cruise, then
 * decelerate. When the move is too short to reach cruise speed the profile
 * degenerates to a triangle. All functions are closed-form and side-effect free.
 *
 * Kept as a reference building block and for tests; coordinated machine moves
 * use the jerk-limited S-curve below (`planLinearMove`).
 */

export interface TrapezoidProfile {
  distance: number;
  /** Highest velocity actually reached (equals the limit unless the profile is triangular). */
  peakVelocity: number;
  accel: number;
  tAccel: number;
  tCruise: number;
  duration: number;
}

export interface ProfileSample {
  position: number;
  velocity: number;
  acceleration: number;
}

export function planTrapezoid(distance: number, maxVelocity: number, maxAccel: number): TrapezoidProfile {
  if (!(maxVelocity > 0) || !(maxAccel > 0)) {
    throw new RangeError(
      `Velocity and acceleration limits must be positive (got ${maxVelocity}, ${maxAccel})`,
    );
  }
  if (!(distance > 0)) {
    return { distance: 0, peakVelocity: 0, accel: maxAccel, tAccel: 0, tCruise: 0, duration: 0 };
  }
  const tAccelFull = maxVelocity / maxAccel;
  const dAccelFull = 0.5 * maxAccel * tAccelFull * tAccelFull;
  if (2 * dAccelFull >= distance) {
    // Triangular: never reaches maxVelocity.
    const peak = Math.sqrt(distance * maxAccel);
    const tAccel = peak / maxAccel;
    return { distance, peakVelocity: peak, accel: maxAccel, tAccel, tCruise: 0, duration: 2 * tAccel };
  }
  const tCruise = (distance - 2 * dAccelFull) / maxVelocity;
  return {
    distance,
    peakVelocity: maxVelocity,
    accel: maxAccel,
    tAccel: tAccelFull,
    tCruise,
    duration: 2 * tAccelFull + tCruise,
  };
}

/** Position/velocity/acceleration along the profile at time `t` (s), clamped to [0, duration]. */
export function sampleTrapezoid(p: TrapezoidProfile, t: number): ProfileSample {
  if (t <= 0 || p.duration === 0) return { position: 0, velocity: 0, acceleration: 0 };
  if (t >= p.duration) return { position: p.distance, velocity: 0, acceleration: 0 };
  const a = p.accel;
  if (t < p.tAccel) return { position: 0.5 * a * t * t, velocity: a * t, acceleration: a };
  const tDecel = p.tAccel + p.tCruise;
  if (t < tDecel) {
    return {
      position: 0.5 * a * p.tAccel * p.tAccel + p.peakVelocity * (t - p.tAccel),
      velocity: p.peakVelocity,
      acceleration: 0,
    };
  }
  const remaining = p.duration - t;
  return {
    position: p.distance - 0.5 * a * remaining * remaining,
    velocity: a * remaining,
    acceleration: -a,
  };
}

/**
 * Coordinated straight-line move of the tool tip. The path gets one jerk-limited
 * S-curve whose velocity, acceleration and jerk limits are the tightest of the
 * per-axis limits projected onto the direction of travel, so every axis follows
 * a scaled S-curve, no axis exceeds its own limits, and all axes arrive together.
 */
export interface LinearMovePlan {
  from: Vec3;
  to: Vec3;
  /** Unit vector of the direction of travel (zero for a null move). */
  unit: Vec3;
  length: number;
  profile: SCurveProfile;
  requestedSpeed: number;
  /** Path speed after applying per-axis velocity limits. */
  effectiveSpeed: number;
  /** Axis whose velocity limit caps the path speed, if any. */
  limitingAxis: AxisName | null;
}

export function planLinearMove(
  from: Vec3,
  to: Vec3,
  requestedSpeed: number,
  axes: Record<AxisName, AxisConfig>,
): LinearMovePlan {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const length = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (length === 0) {
    return {
      from: { ...from },
      to: { ...to },
      unit: { x: 0, y: 0, z: 0 },
      length: 0,
      profile: planSCurve(0, 1, 1, 1),
      requestedSpeed,
      effectiveSpeed: requestedSpeed,
      limitingAxis: null,
    };
  }
  const unit = { x: d.x / length, y: d.y / length, z: d.z / length };
  let vMax = requestedSpeed;
  let aMax = Infinity;
  let jMax = Infinity;
  let limitingAxis: AxisName | null = null;
  for (const axis of AXES) {
    const u = Math.abs(unit[axis]);
    if (u < 1e-12) continue;
    const vAxis = axes[axis].maxSpeed / u;
    if (vAxis < vMax) {
      vMax = vAxis;
      limitingAxis = axis;
    }
    aMax = Math.min(aMax, axes[axis].maxAccel / u);
    jMax = Math.min(jMax, axes[axis].maxJerk / u);
  }
  return {
    from: { ...from },
    to: { ...to },
    unit,
    length,
    profile: planSCurve(length, vMax, aMax, jMax),
    requestedSpeed,
    effectiveSpeed: vMax,
    limitingAxis,
  };
}

export interface MoveSample {
  position: Vec3;
  velocity: Vec3;
  acceleration: Vec3;
}

export function sampleLinearMove(plan: LinearMovePlan, t: number): MoveSample {
  if (t >= plan.profile.duration) {
    return { position: { ...plan.to }, velocity: { x: 0, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 } };
  }
  const s = sampleSCurve(plan.profile, t);
  return {
    position: {
      x: plan.from.x + plan.unit.x * s.position,
      y: plan.from.y + plan.unit.y * s.position,
      z: plan.from.z + plan.unit.z * s.position,
    },
    velocity: { x: plan.unit.x * s.velocity, y: plan.unit.y * s.velocity, z: plan.unit.z * s.velocity },
    acceleration: {
      x: plan.unit.x * s.acceleration,
      y: plan.unit.y * s.acceleration,
      z: plan.unit.z * s.acceleration,
    },
  };
}
