/**
 * Jerk-limited (double-S / S-curve) motion profiles, rest to rest.
 *
 * A trapezoidal profile steps acceleration instantly, which a real drive cannot
 * do and which excites machine vibration. An S-curve bounds the jerk (the rate
 * of change of acceleration) as well as acceleration and velocity, so the
 * command is twice differentiable — smoother on the hardware and on the eye.
 *
 * The profile has up to seven phases: jerk up / const accel / jerk down /
 * cruise / jerk down / const decel / jerk up. The segment durations follow the
 * standard construction for v0 = v1 = 0, a0 = a1 = 0 (Biagiotti & Melchiorri,
 * "Trajectory Planning for Automatic Machines and Robots", §3.4), handling the
 * cases where the velocity limit, the acceleration limit, or neither is reached.
 *
 * Sampling integrates each phase in closed form from its boundary state, so the
 * result is exact and continuous in position, velocity and acceleration.
 */

export interface SCurveProfile {
  distance: number;
  duration: number;
  /** Highest velocity actually reached (≤ the limit). */
  peakVelocity: number;
  /** Highest acceleration actually reached (≤ the limit). */
  peakAcceleration: number;
  /** Phase boundaries with the state at the start of each phase. */
  readonly phases: readonly Phase[];
}

interface Phase {
  /** Start time of the phase, s. */
  t0: number;
  duration: number;
  /** Constant jerk during the phase, mm/s³. */
  jerk: number;
  p0: number;
  v0: number;
  a0: number;
}

export interface MotionSample {
  position: number;
  velocity: number;
  acceleration: number;
}

const EPS = 1e-9;

export function planSCurve(distance: number, vMax: number, aMax: number, jMax: number): SCurveProfile {
  if (!(vMax > 0) || !(aMax > 0) || !(jMax > 0)) {
    throw new RangeError(`S-curve limits must be positive (got v=${vMax}, a=${aMax}, j=${jMax})`);
  }
  if (!(distance > EPS)) {
    return { distance: 0, duration: 0, peakVelocity: 0, peakAcceleration: 0, phases: [] };
  }

  // Hypothesis: the velocity limit is reached.
  let tJerk: number;
  let tAcc: number; // total acceleration-phase duration
  if (vMax * jMax < aMax * aMax) {
    // The acceleration limit is not reached even at the velocity limit.
    tJerk = Math.sqrt(vMax / jMax);
    tAcc = 2 * tJerk;
  } else {
    tJerk = aMax / jMax;
    tAcc = tJerk + vMax / aMax;
  }
  let tCruise = distance / vMax - tAcc;

  let peakVelocity: number;
  let peakAcceleration: number;
  let tConstAcc: number; // constant-acceleration sub-phase of the accel phase

  if (tCruise > EPS) {
    // Velocity limit reached, with a cruise phase.
    peakVelocity = vMax;
    peakAcceleration = vMax * jMax < aMax * aMax ? jMax * tJerk : aMax;
    tConstAcc = tAcc - 2 * tJerk;
  } else {
    // Velocity limit not reached: a shorter move.
    tCruise = 0;
    if (distance >= (2 * aMax * aMax * aMax) / (jMax * jMax)) {
      // Acceleration limit still reached.
      tJerk = aMax / jMax;
      const c = (-3 * tJerk + Math.sqrt(tJerk * tJerk + (4 * distance) / aMax)) / 2;
      tConstAcc = Math.max(0, c);
      peakAcceleration = aMax;
      peakVelocity = aMax * (tConstAcc + tJerk);
    } else {
      // Neither limit reached: pure jerk up/down.
      tJerk = Math.cbrt(distance / (2 * jMax));
      tConstAcc = 0;
      peakAcceleration = jMax * tJerk;
      peakVelocity = jMax * tJerk * tJerk;
    }
  }

  const durations = [tJerk, tConstAcc, tJerk, tCruise, tJerk, tConstAcc, tJerk];
  const jerks = [jMax, 0, -jMax, 0, -jMax, 0, jMax];

  // Integrate boundary states forward through the phases.
  const phases: Phase[] = [];
  let t0 = 0;
  let p = 0;
  let v = 0;
  let a = 0;
  for (let i = 0; i < 7; i++) {
    const dur = durations[i] ?? 0;
    const jerk = jerks[i] ?? 0;
    if (dur <= EPS && i !== 3) continue; // keep the (possibly zero) cruise slot out too
    phases.push({ t0, duration: dur, jerk, p0: p, v0: v, a0: a });
    const end = integrate(p, v, a, jerk, dur);
    p = end.position;
    v = end.velocity;
    a = end.acceleration;
    t0 += dur;
  }

  return {
    distance,
    duration: t0,
    peakVelocity,
    peakAcceleration,
    phases,
  };
}

function integrate(p0: number, v0: number, a0: number, jerk: number, dt: number): MotionSample {
  return {
    position: p0 + v0 * dt + 0.5 * a0 * dt * dt + (jerk * dt * dt * dt) / 6,
    velocity: v0 + a0 * dt + 0.5 * jerk * dt * dt,
    acceleration: a0 + jerk * dt,
  };
}

/** State along the profile at time `t` (s), clamped to [0, duration]. */
export function sampleSCurve(profile: SCurveProfile, t: number): MotionSample {
  if (profile.duration === 0 || t <= 0) {
    return { position: 0, velocity: 0, acceleration: 0 };
  }
  if (t >= profile.duration) {
    return { position: profile.distance, velocity: 0, acceleration: 0 };
  }
  // Phases are few (≤ 7); a linear scan is fine and branch-predictable.
  let phase = profile.phases[0];
  for (const candidate of profile.phases) {
    if (t >= candidate.t0) phase = candidate;
    else break;
  }
  if (!phase) return { position: 0, velocity: 0, acceleration: 0 };
  return integrate(phase.p0, phase.v0, phase.a0, phase.jerk, t - phase.t0);
}
