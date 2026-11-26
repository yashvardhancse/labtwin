import type { Bus } from '../bus.ts';
import { fmt } from '../protocol.ts';
import type { MachineConfig } from '../machine.ts';
import type { PumpMode } from '../topics.ts';
import { accepted, rejected, round, type Response } from './common.ts';

export interface PumpRequest {
  op: 'aspirate' | 'dispense';
  volumeNl: number;
  rateNlS: number;
}

/**
 * Syringe-pump driver node. `call()` is the service interface
 * (`/pump/aspirate`, `/pump/dispense`): it accepts or rejects immediately and
 * the pump then runs at the requested flow rate, publishing `/pump/state`.
 */
export class PumpDriver {
  readonly name = 'pump_driver';
  volumeNl = 0;
  mode: PumpMode = 'idle';
  /** Signed flow, nL/s. */
  flowNlS = 0;

  readonly #m: MachineConfig;
  #targetNl = 0;

  constructor(machine: MachineConfig) {
    this.#m = machine;
  }

  get busy(): boolean {
    return this.mode !== 'idle';
  }

  call(request: PumpRequest): Response {
    if (this.busy) return rejected('The pump is busy.');
    if (!(request.volumeNl > 0) || !(request.rateNlS > 0))
      return rejected('Volume and rate must be positive.');
    if (request.op === 'aspirate') {
      if (this.volumeNl + request.volumeNl > this.#m.pump.capacityNl + 1e-9) {
        return rejected(`Aspirating ${fmt(request.volumeNl)} nL would overfill the syringe.`);
      }
      this.#targetNl = this.volumeNl + request.volumeNl;
      this.flowNlS = request.rateNlS;
      this.mode = 'aspirating';
    } else {
      if (request.volumeNl > this.volumeNl + 1e-9) {
        return rejected(
          `Only ${fmt(this.volumeNl)} nL in the syringe; cannot dispense ${fmt(request.volumeNl)} nL.`,
        );
      }
      this.#targetNl = this.volumeNl - request.volumeNl;
      this.flowNlS = -request.rateNlS;
      this.mode = 'dispensing';
    }
    return accepted;
  }

  stop(): void {
    this.mode = 'idle';
    this.flowNlS = 0;
  }

  tick(dt: number): void {
    if (this.mode === 'idle') return;
    const next = this.volumeNl + this.flowNlS * dt;
    const reached = this.flowNlS > 0 ? next >= this.#targetNl : next <= this.#targetNl;
    if (reached) {
      this.volumeNl = this.#targetNl;
      this.stop();
    } else {
      this.volumeNl = next;
    }
  }

  publish(bus: Bus): void {
    bus.publish('/pump/state', {
      volume_nl: round(this.volumeNl, 4),
      flow_nl_s: round(this.flowNlS, 3),
      mode: this.mode,
    });
  }
}
