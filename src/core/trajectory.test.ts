import { describe, expect, it } from 'vitest';
import { DEFAULT_MACHINE } from './machine.ts';
import { planLinearMove, planTrapezoid, sampleLinearMove, sampleTrapezoid } from './trajectory.ts';

/** Sample a profile every `dt` seconds, including the exact end point. */
function sweep(duration: number, dt = 1e-4): number[] {
  const times: number[] = [];
  for (let t = 0; t < duration; t += dt) times.push(t);
  times.push(duration);
  return times;
}

describe('planTrapezoid', () => {
  it('reaches the target exactly and stops there', () => {
    const p = planTrapezoid(50, 40, 400);
    expect(sampleTrapezoid(p, p.duration)).toEqual({ position: 50, velocity: 0, acceleration: 0 });
    expect(sampleTrapezoid(p, p.duration + 1).position).toBe(50);
  });

  it('never exceeds the velocity or acceleration limit', () => {
    const vMax = 40;
    const aMax = 400;
    const p = planTrapezoid(50, vMax, aMax);
    const dt = 1e-4;
    let previous = sampleTrapezoid(p, 0);
    for (const t of sweep(p.duration, dt).slice(1)) {
      const s = sampleTrapezoid(p, t);
      expect(s.velocity).toBeLessThanOrEqual(vMax + 1e-9);
      expect(s.velocity).toBeGreaterThanOrEqual(0);
      expect(Math.abs(s.velocity - previous.velocity) / dt).toBeLessThanOrEqual(aMax * (1 + 1e-6));
      expect(s.position).toBeGreaterThanOrEqual(previous.position);
      previous = s;
    }
  });

  it('cruises at the limit on long moves with the textbook duration T = d/v + v/a', () => {
    const p = planTrapezoid(100, 50, 500);
    expect(p.peakVelocity).toBe(50);
    expect(p.tCruise).toBeGreaterThan(0);
    expect(p.duration).toBeCloseTo(100 / 50 + 50 / 500, 12);
  });

  it('degenerates to a triangle when the move is too short to reach cruise speed', () => {
    const p = planTrapezoid(2, 50, 500); // needs 5 mm to reach 50 mm/s
    expect(p.tCruise).toBe(0);
    expect(p.peakVelocity).toBeCloseTo(Math.sqrt(2 * 500), 12);
    expect(p.peakVelocity).toBeLessThan(50);
    expect(sampleTrapezoid(p, p.duration).position).toBe(2);
  });

  it('is continuous in position and velocity at the phase boundaries', () => {
    const p = planTrapezoid(30, 40, 400);
    for (const boundary of [p.tAccel, p.tAccel + p.tCruise]) {
      const before = sampleTrapezoid(p, boundary - 1e-9);
      const after = sampleTrapezoid(p, boundary + 1e-9);
      expect(after.position - before.position).toBeLessThan(1e-6);
      expect(Math.abs(after.velocity - before.velocity)).toBeLessThan(1e-5);
    }
  });

  it('treats a zero-length move as already finished', () => {
    const p = planTrapezoid(0, 40, 400);
    expect(p.duration).toBe(0);
    expect(sampleTrapezoid(p, 0.5)).toEqual({ position: 0, velocity: 0, acceleration: 0 });
  });

  it('rejects non-positive limits', () => {
    expect(() => planTrapezoid(10, 0, 400)).toThrow(RangeError);
    expect(() => planTrapezoid(10, 40, -1)).toThrow(RangeError);
  });
});

describe('planLinearMove', () => {
  const axes = DEFAULT_MACHINE.axes;

  it('moves in a straight line and every axis arrives at the same time', () => {
    const from = { x: 0, y: 0, z: 40 };
    const to = { x: 100, y: 60, z: 20 };
    const plan = planLinearMove(from, to, 60, axes);
    for (const t of sweep(plan.profile.duration, 1e-3)) {
      const { position } = sampleLinearMove(plan, t);
      // On the segment: the offset from `from` is parallel to the direction.
      const off = { x: position.x - from.x, y: position.y - from.y, z: position.z - from.z };
      const along = off.x * plan.unit.x + off.y * plan.unit.y + off.z * plan.unit.z;
      const perpendicular = Math.hypot(
        off.x - along * plan.unit.x,
        off.y - along * plan.unit.y,
        off.z - along * plan.unit.z,
      );
      expect(perpendicular).toBeLessThan(1e-9);
    }
    expect(sampleLinearMove(plan, plan.profile.duration).position).toEqual(to);
  });

  it('caps the path speed so no axis exceeds its own velocity limit', () => {
    // Mostly vertical move: Z (40 mm/s) limits the requested 100 mm/s.
    const plan = planLinearMove({ x: 0, y: 0, z: 40 }, { x: 5, y: 0, z: 0 }, 100, axes);
    expect(plan.limitingAxis).toBe('z');
    expect(plan.effectiveSpeed).toBeLessThan(100);
    for (const t of sweep(plan.profile.duration, 1e-3)) {
      const { velocity } = sampleLinearMove(plan, t);
      expect(Math.abs(velocity.z)).toBeLessThanOrEqual(axes.z.maxSpeed + 1e-9);
      expect(Math.abs(velocity.x)).toBeLessThanOrEqual(axes.x.maxSpeed + 1e-9);
    }
  });

  it('keeps the requested speed when no axis limit is hit', () => {
    const plan = planLinearMove({ x: 0, y: 0, z: 40 }, { x: 100, y: 0, z: 40 }, 60, axes);
    expect(plan.limitingAxis).toBeNull();
    expect(plan.effectiveSpeed).toBe(60);
    expect(plan.profile.peakVelocity).toBe(60);
  });
});
