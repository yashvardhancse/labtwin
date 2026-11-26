import { describe, expect, it } from 'vitest';
import { planSCurve, sampleSCurve } from './scurve.ts';

function sweep(duration: number, dt = 2e-4): number[] {
  const times: number[] = [];
  for (let t = 0; t < duration; t += dt) times.push(t);
  times.push(duration);
  return times;
}

describe('planSCurve', () => {
  it('rejects non-positive limits', () => {
    expect(() => planSCurve(10, 0, 500, 5000)).toThrow(RangeError);
    expect(() => planSCurve(10, 50, -1, 5000)).toThrow(RangeError);
    expect(() => planSCurve(10, 50, 500, 0)).toThrow(RangeError);
  });

  it('treats a zero move as already finished', () => {
    const p = planSCurve(0, 50, 500, 5000);
    expect(p.duration).toBe(0);
    expect(p.phases).toHaveLength(0);
    expect(sampleSCurve(p, 1)).toEqual({ position: 0, velocity: 0, acceleration: 0 });
  });

  it('reaches the target exactly and rests there', () => {
    for (const distance of [2, 20, 200]) {
      const p = planSCurve(distance, 50, 500, 5000);
      const end = sampleSCurve(p, p.duration);
      expect(end.position).toBeCloseTo(distance, 9);
      expect(end.velocity).toBe(0);
      expect(end.acceleration).toBe(0);
      expect(sampleSCurve(p, p.duration + 5).position).toBeCloseTo(distance, 9);
    }
  });

  it('never exceeds the velocity, acceleration or jerk limits', () => {
    const vMax = 50;
    const aMax = 500;
    const jMax = 5000;
    const p = planSCurve(200, vMax, aMax, jMax);
    for (const phase of p.phases) expect(Math.abs(phase.jerk)).toBeLessThanOrEqual(jMax + 1e-6);
    let previous = sampleSCurve(p, 0);
    for (const t of sweep(p.duration).slice(1)) {
      const s = sampleSCurve(p, t);
      expect(Math.abs(s.velocity)).toBeLessThanOrEqual(vMax + 1e-6);
      expect(Math.abs(s.acceleration)).toBeLessThanOrEqual(aMax + 1e-6);
      expect(s.position).toBeGreaterThanOrEqual(previous.position - 1e-9); // monotonic
      previous = s;
    }
  });

  it('is continuous in position, velocity AND acceleration (unlike a trapezoid)', () => {
    const p = planSCurve(120, 60, 500, 4000);
    let cumulative = 0;
    for (const phase of p.phases.slice(0, -1)) {
      cumulative += phase.duration;
      const before = sampleSCurve(p, cumulative - 1e-7);
      const after = sampleSCurve(p, cumulative + 1e-7);
      expect(Math.abs(after.position - before.position)).toBeLessThan(1e-4);
      expect(Math.abs(after.velocity - before.velocity)).toBeLessThan(1e-3);
      expect(Math.abs(after.acceleration - before.acceleration)).toBeLessThan(1e-2);
    }
  });

  it('matches the double integral of its own acceleration', () => {
    // Independent check: integrate a(t) twice and compare with the closed form.
    const p = planSCurve(80, 45, 400, 6000);
    const dt = 1e-4;
    let v = 0;
    let x = 0;
    for (let t = 0; t < p.duration; t += dt) {
      const a = sampleSCurve(p, t + dt / 2).acceleration; // midpoint
      v += a * dt;
      x += v * dt;
    }
    expect(x).toBeCloseTo(p.distance, 1);
    expect(v).toBeCloseTo(0, 2);
  });

  it('has a velocity profile symmetric about the midpoint (rest to rest)', () => {
    const p = planSCurve(140, 55, 500, 5000);
    for (const frac of [0.1, 0.25, 0.5]) {
      const t = frac * p.duration;
      expect(sampleSCurve(p, t).velocity).toBeCloseTo(sampleSCurve(p, p.duration - t).velocity, 6);
    }
  });

  it('reaches the velocity limit on a long move, with a cruise phase', () => {
    const p = planSCurve(300, 50, 500, 5000);
    expect(p.peakVelocity).toBeCloseTo(50, 6);
    expect(p.peakAcceleration).toBeCloseTo(500, 6);
    // Midpoint is at the velocity limit (cruise).
    expect(sampleSCurve(p, p.duration / 2).velocity).toBeCloseTo(50, 6);
  });

  it('reaches the acceleration but not the velocity limit on a medium move', () => {
    const p = planSCurve(20, 100, 500, 5000); // 20 ≥ 2·A³/J² = 10
    expect(p.peakAcceleration).toBeCloseTo(500, 6);
    expect(p.peakVelocity).toBeLessThan(100);
    expect(p.peakVelocity).toBeGreaterThan(0);
  });

  it('reaches neither limit on a very short move', () => {
    const p = planSCurve(5, 100, 500, 5000); // 5 < 10
    expect(p.peakAcceleration).toBeLessThan(500);
    expect(p.peakVelocity).toBeLessThan(100);
    expect(sampleSCurve(p, p.duration).position).toBeCloseTo(5, 9);
  });

  it('is deterministic', () => {
    const a = planSCurve(73.5, 42, 480, 5200);
    const b = planSCurve(73.5, 42, 480, 5200);
    expect(a).toEqual(b);
  });
});
