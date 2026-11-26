import type { Bus } from '../bus.ts';
import { fmt } from '../protocol.ts';
import type { MachineConfig } from '../machine.ts';
import type { Rng } from '../rng.ts';
import { accepted, rejected, round, type Response } from './common.ts';

/**
 * Cryo-stage controller node. `setTarget()` is the `/stage/set_target`
 * service; the plate approaches the set-point exponentially
 * (dT/dt = (T_set − T) / τ), the behaviour of a well-tuned temperature loop.
 */
export class StageController {
  readonly name = 'stage_controller';
  temperatureC: number;
  targetC: number;

  readonly #m: MachineConfig;
  readonly #rng: Rng;

  constructor(machine: MachineConfig, rng: Rng) {
    this.#m = machine;
    this.#rng = rng;
    this.temperatureC = machine.stage.ambientC;
    this.targetC = machine.stage.ambientC;
  }

  setTarget(celsius: number): Response {
    const { minC, maxC } = this.#m.stage;
    if (!(celsius >= minC && celsius <= maxC)) {
      return rejected(`Set-point ${fmt(celsius)} °C is outside ${fmt(minC)} to ${fmt(maxC)} °C.`);
    }
    this.targetC = celsius;
    return accepted;
  }

  atTarget(): boolean {
    return Math.abs(this.temperatureC - this.targetC) <= this.#m.stage.toleranceC;
  }

  tick(dt: number): void {
    this.temperatureC += (this.targetC - this.temperatureC) * (dt / this.#m.stage.tauS);
  }

  publish(bus: Bus): void {
    bus.publish('/stage/temperature', {
      celsius: round(this.temperatureC + this.#rng.gaussian() * this.#m.stage.noiseC, 2),
      target_c: this.targetC,
    });
  }
}
