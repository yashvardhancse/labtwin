import type { Bus } from '../bus.ts';
import { AXES, homePosition, type AxisName, type MachineConfig, type Vec3 } from '../machine.ts';
import type { Rng } from '../rng.ts';
import { AXIS_TOPIC } from '../topics.ts';
import { planLinearMove, sampleLinearMove, type LinearMovePlan } from '../trajectory.ts';
import { accepted, rejected, round, type Response } from './common.ts';

export type MotionGoal =
  { kind: 'home' } | { kind: 'move'; target: Partial<Record<AxisName, number>>; speed: number };

export type GoalState = 'idle' | 'executing' | 'succeeded' | 'aborted';

/**
 * Gantry driver node: an action server for motion goals plus a model of three
 * servo axes. In a real machine the trajectory and position loops run in the
 * PLC/drives (EtherCAT at 1 kHz) and this node would only relay goals and
 * publish states; here both halves are simulated.
 *
 * Servo model per axis (1 kHz): a cascaded position/velocity controller with
 * velocity and acceleration feed-forward, a velocity-loop integrator with
 * anti-windup, and a first-order current loop. The feed-forward cancels most of
 * the jerk-limited trajectory; the lag and finite gains leave a realistic
 * following error — tens of µm while accelerating, near zero at constant speed.
 */
export class GantryDriver {
  readonly name = 'gantry_driver';
  homed = false;
  /** Commanded position/velocity/acceleration from the trajectory generator. */
  readonly cmd: Vec3;
  readonly cmdVel: Vec3 = { x: 0, y: 0, z: 0 };
  readonly cmdAcc: Vec3 = { x: 0, y: 0, z: 0 };
  /** True (noise-free) axis position/velocity. */
  readonly act: Vec3;
  readonly actVel: Vec3 = { x: 0, y: 0, z: 0 };
  /** Current-loop acceleration (lagged) and velocity-loop integrator, per axis. */
  readonly #actAcc: Vec3 = { x: 0, y: 0, z: 0 };
  readonly #integ: Vec3 = { x: 0, y: 0, z: 0 };

  readonly #m: MachineConfig;
  readonly #rng: Rng;
  #segments: LinearMovePlan[] = [];
  #segment = 0;
  #segmentTime = 0;
  #homing = false;
  #state: GoalState = 'idle';

  constructor(machine: MachineConfig, rng: Rng) {
    this.#m = machine;
    this.#rng = rng;
    this.cmd = { ...machine.powerOn };
    this.act = { ...machine.powerOn };
  }

  get goalState(): GoalState {
    return this.#state;
  }

  /** Action goal request (`/gantry/move`, `/gantry/home`). */
  sendGoal(goal: MotionGoal): Response {
    if (this.#state === 'executing') return rejected('A motion goal is already executing.');
    const m = this.#m;
    if (goal.kind === 'move') {
      if (!this.homed) return rejected('The axes are not homed.');
      if (!(goal.speed > 0)) return rejected('Speed must be positive.');
      const target: Vec3 = {
        x: goal.target.x ?? this.cmd.x,
        y: goal.target.y ?? this.cmd.y,
        z: goal.target.z ?? this.cmd.z,
      };
      for (const axis of AXES) {
        const { min, max } = m.axes[axis];
        if (target[axis] < min - 1e-9 || target[axis] > max + 1e-9) {
          return rejected(`${axis.toUpperCase()} target ${target[axis]} mm is outside ${min}–${max} mm.`);
        }
      }
      this.#segments = [planLinearMove(this.cmd, target, goal.speed, m.axes)];
      this.#homing = false;
    } else {
      // Homing: lift Z to its reference first, then reference X and Y together.
      const home = homePosition(m);
      const lifted = { ...this.cmd, z: home.z };
      this.#segments = [
        planLinearMove(this.cmd, lifted, m.axes.z.homingSpeed, m.axes),
        planLinearMove(lifted, home, m.axes.x.homingSpeed, m.axes),
      ];
      this.#homing = true;
    }
    this.#segment = 0;
    this.#segmentTime = 0;
    this.#state = 'executing';
    return accepted;
  }

  /** Abort the current goal; the command freezes and the servo holds position. */
  cancel(): void {
    if (this.#state !== 'executing') return;
    this.#segments = [];
    this.#state = 'aborted';
    for (const axis of AXES) this.cmdVel[axis] = 0;
  }

  /** Advance the trajectory generator and the servo loops by `dt` seconds. */
  tick(dt: number): void {
    const n = this.#m.servo.substeps;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.#updateCommand(h);
      this.#updateServo(h);
    }
    if (this.#state === 'executing' && this.#segment >= this.#segments.length && this.#inPosition()) {
      if (this.#homing) this.homed = true;
      this.#state = 'succeeded';
    }
  }

  publish(bus: Bus): void {
    const noise = this.#m.servo.noiseMm;
    for (const axis of AXES) {
      bus.publish(AXIS_TOPIC[axis], {
        axis,
        cmd_mm: round(this.cmd[axis], 4),
        actual_mm: round(this.act[axis] + this.#rng.gaussian() * noise, 4),
        velocity_mm_s: round(this.actVel[axis], 3),
        homed: this.homed,
      });
    }
  }

  #updateCommand(h: number): void {
    if (this.#state !== 'executing' || this.#segment >= this.#segments.length) {
      this.cmdVel.x = this.cmdVel.y = this.cmdVel.z = 0;
      return;
    }
    this.#segmentTime += h;
    let plan = this.#segments[this.#segment];
    while (plan && this.#segmentTime >= plan.profile.duration) {
      // Segment complete: carry the leftover time into the next one.
      this.#segmentTime -= plan.profile.duration;
      this.#segment++;
      const next = this.#segments[this.#segment];
      if (!next) {
        Object.assign(this.cmd, plan.to);
        this.cmdVel.x = this.cmdVel.y = this.cmdVel.z = 0;
        this.cmdAcc.x = this.cmdAcc.y = this.cmdAcc.z = 0;
        return;
      }
      plan = next;
    }
    if (!plan) return;
    const sample = sampleLinearMove(plan, this.#segmentTime);
    Object.assign(this.cmd, sample.position);
    Object.assign(this.cmdVel, sample.velocity);
    Object.assign(this.cmdAcc, sample.acceleration);
  }

  /**
   * Cascaded controller, one 1 kHz step. Position loop (P) feeds the velocity
   * loop (PI with anti-windup); velocity and acceleration feed-forward cancel
   * most of the trajectory, and a first-order current loop keeps acceleration
   * from changing instantly — the source of the residual following error.
   */
  #updateServo(h: number): void {
    const { kpPos, kpVel, kiVel, integralClampMm, tauCurrentS } = this.#m.servo;
    for (const axis of AXES) {
      const positionError = this.cmd[axis] - this.act[axis];
      const velocityRef = this.cmdVel[axis] + kpPos * positionError;
      const velocityError = velocityRef - this.actVel[axis];

      const integ = clamp(this.#integ[axis] + velocityError * h, integralClampMm);
      this.#integ[axis] = integ;

      const accelCmd = this.cmdAcc[axis] + kpVel * velocityError + kiVel * integ;
      this.#actAcc[axis] += (accelCmd - this.#actAcc[axis]) * (h / tauCurrentS);
      this.actVel[axis] += this.#actAcc[axis] * h;
      this.act[axis] += this.actVel[axis] * h;
    }
  }

  #inPosition(): boolean {
    const tolerance = this.#m.servo.inPositionMm;
    return AXES.every(
      (axis) => Math.abs(this.cmd[axis] - this.act[axis]) <= tolerance && Math.abs(this.actVel[axis]) < 0.2,
    );
  }
}

function clamp(value: number, limit: number): number {
  return value < -limit ? -limit : value > limit ? limit : value;
}
