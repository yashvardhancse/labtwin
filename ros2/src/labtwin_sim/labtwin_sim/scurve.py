"""Jerk-limited (double-S) motion profiles, rest to rest.

A Python port of the browser twin's ``src/core/scurve.ts``. Bounding jerk as
well as acceleration and velocity makes the command twice differentiable, so it
is gentle on the hardware and does not excite structural vibration — which is
why real motion controllers use S-curves. The seven phases are jerk up /
const accel / jerk down / cruise / jerk down / const decel / jerk up; sampling
integrates each phase in closed form from its boundary state.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import sqrt

EPS = 1e-9


@dataclass(frozen=True)
class Phase:
    t0: float
    duration: float
    jerk: float
    p0: float
    v0: float
    a0: float


@dataclass(frozen=True)
class SCurveProfile:
    distance: float
    duration: float
    peak_velocity: float
    peak_acceleration: float
    phases: tuple[Phase, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class MotionSample:
    position: float
    velocity: float
    acceleration: float


def _integrate(p0: float, v0: float, a0: float, jerk: float, dt: float) -> MotionSample:
    return MotionSample(
        position=p0 + v0 * dt + 0.5 * a0 * dt * dt + jerk * dt * dt * dt / 6.0,
        velocity=v0 + a0 * dt + 0.5 * jerk * dt * dt,
        acceleration=a0 + jerk * dt,
    )


def plan_scurve(distance: float, v_max: float, a_max: float, j_max: float) -> SCurveProfile:
    if v_max <= 0 or a_max <= 0 or j_max <= 0:
        raise ValueError(f"S-curve limits must be positive (got v={v_max}, a={a_max}, j={j_max})")
    if distance <= EPS:
        return SCurveProfile(0.0, 0.0, 0.0, 0.0, ())

    # Hypothesis: the velocity limit is reached.
    if v_max * j_max < a_max * a_max:
        t_jerk = sqrt(v_max / j_max)
        t_acc = 2 * t_jerk
    else:
        t_jerk = a_max / j_max
        t_acc = t_jerk + v_max / a_max
    t_cruise = distance / v_max - t_acc

    if t_cruise > EPS:
        peak_velocity = v_max
        peak_acceleration = j_max * t_jerk if v_max * j_max < a_max * a_max else a_max
        t_const_acc = t_acc - 2 * t_jerk
    else:
        t_cruise = 0.0
        if distance >= 2 * a_max**3 / (j_max * j_max):
            t_jerk = a_max / j_max
            c = (-3 * t_jerk + sqrt(t_jerk * t_jerk + 4 * distance / a_max)) / 2
            t_const_acc = max(0.0, c)
            peak_acceleration = a_max
            peak_velocity = a_max * (t_const_acc + t_jerk)
        else:
            t_jerk = (distance / (2 * j_max)) ** (1.0 / 3.0)
            t_const_acc = 0.0
            peak_acceleration = j_max * t_jerk
            peak_velocity = j_max * t_jerk * t_jerk

    durations = [t_jerk, t_const_acc, t_jerk, t_cruise, t_jerk, t_const_acc, t_jerk]
    jerks = [j_max, 0.0, -j_max, 0.0, -j_max, 0.0, j_max]

    phases: list[Phase] = []
    t0 = p = v = a = 0.0
    for i in range(7):
        dur = durations[i]
        jerk = jerks[i]
        if dur <= EPS and i != 3:
            continue
        phases.append(Phase(t0=t0, duration=dur, jerk=jerk, p0=p, v0=v, a0=a))
        end = _integrate(p, v, a, jerk, dur)
        p, v, a = end.position, end.velocity, end.acceleration
        t0 += dur

    return SCurveProfile(distance, t0, peak_velocity, peak_acceleration, tuple(phases))


def sample_scurve(profile: SCurveProfile, t: float) -> MotionSample:
    if profile.duration == 0 or t <= 0:
        return MotionSample(0.0, 0.0, 0.0)
    if t >= profile.duration:
        return MotionSample(profile.distance, 0.0, 0.0)
    phase = profile.phases[0]
    for candidate in profile.phases:
        if t >= candidate.t0:
            phase = candidate
        else:
            break
    return _integrate(phase.p0, phase.v0, phase.a0, phase.jerk, t - phase.t0)
