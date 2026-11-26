import { Bus } from './bus.ts';
import { DEFAULT_MACHINE, type MachineConfig } from './machine.ts';
import { ProtocolExecutor } from './nodes/executor.ts';
import { GantryDriver } from './nodes/gantry.ts';
import { PumpDriver } from './nodes/pump.ts';
import { StageController } from './nodes/stage.ts';
import type { Protocol } from './protocol.ts';
import { createRng, deriveSeed } from './rng.ts';
import { RunLog } from './runLog.ts';

/**
 * Deterministic, fixed-step simulation of the robot.
 *
 * Each 10 ms tick runs the nodes in a fixed order — executor (decides), then
 * gantry (1 kHz servo sub-steps), pump and stage (physics), then publishing.
 * All noise comes from seeded RNG streams, so the same protocol + seed always
 * produces bit-identical messages.
 */

export interface SimulationOptions {
  seed?: number;
  machine?: MachineConfig;
  /** Fixed time step, ms. */
  dtMs?: number;
  /** Safety limit on simulated time, ms. */
  maxDurationMs?: number;
}

export const DEFAULT_SEED = 42;
export const DEFAULT_DT_MS = 10;

export class Simulation {
  readonly bus = new Bus();
  readonly protocol: Protocol;
  readonly machine: MachineConfig;
  readonly seed: number;
  readonly dtMs: number;
  readonly gantry: GantryDriver;
  readonly pump: PumpDriver;
  readonly stage: StageController;
  readonly executor: ProtocolExecutor;

  readonly #maxTicks: number;
  #tick = 0;
  #started = false;
  #lastPumpMode: string;

  constructor(protocol: Protocol, options: SimulationOptions = {}) {
    this.protocol = protocol;
    this.machine = options.machine ?? DEFAULT_MACHINE;
    this.seed = options.seed ?? DEFAULT_SEED;
    this.dtMs = options.dtMs ?? DEFAULT_DT_MS;
    this.#maxTicks = Math.ceil((options.maxDurationMs ?? 600_000) / this.dtMs);
    this.gantry = new GantryDriver(this.machine, createRng(deriveSeed(this.seed, 1)));
    this.pump = new PumpDriver(this.machine);
    this.stage = new StageController(this.machine, createRng(deriveSeed(this.seed, 2)));
    this.executor = new ProtocolExecutor(
      this.protocol,
      { gantry: this.gantry, pump: this.pump, stage: this.stage },
      this.machine,
      this.bus,
    );
    this.#lastPumpMode = this.pump.mode;
  }

  /** Simulated time, ms. */
  get timeMs(): number {
    return this.#tick * this.dtMs;
  }

  get done(): boolean {
    return this.#started && this.executor.state !== 'running';
  }

  /** Publish the initial state at t = 0 and start the executor. Subscribe recorders first. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.bus.setTime(0);
    this.#publishAll();
    this.executor.start();
  }

  /** Advance one fixed time step. */
  step(): void {
    if (!this.#started) this.start();
    if (this.done) return;
    this.#tick++;
    this.bus.setTime(this.timeMs);

    this.executor.tick(this.timeMs);
    if (this.executor.state === 'running' && this.#tick >= this.#maxTicks) {
      this.executor.abort('The run exceeded the simulation time limit.');
    }
    const dt = this.dtMs / 1000;
    this.gantry.tick(dt);
    this.pump.tick(dt);
    this.stage.tick(dt);

    // Axes at 100 Hz, pump at 50 Hz (and on every mode change), stage at 10 Hz;
    // everything once more on the final tick so the recording ends in a known state.
    const finished = this.executor.state !== 'running';
    this.gantry.publish(this.bus);
    const pumpChanged = this.pump.mode !== this.#lastPumpMode;
    if (finished || pumpChanged || this.#tick % 2 === 0) this.pump.publish(this.bus);
    this.#lastPumpMode = this.pump.mode;
    if (finished || this.#tick % 10 === 0) this.stage.publish(this.bus);
  }

  /** Operator stop. */
  cancel(): void {
    if (!this.#started || this.done) return;
    this.executor.cancel();
    this.#publishFinal();
  }

  /** Run headless until the protocol finishes (tests, CLI export). */
  runToEnd(): void {
    if (!this.#started) this.start();
    while (!this.done) this.step();
  }

  #publishAll(): void {
    this.gantry.publish(this.bus);
    this.pump.publish(this.bus);
    this.stage.publish(this.bus);
  }

  /** Make sure the recording ends with every node's final state. */
  #publishFinal(): void {
    this.pump.publish(this.bus);
    this.stage.publish(this.bus);
  }
}

/** Run a protocol to completion and return its recording. */
export function simulate(
  protocol: Protocol,
  options: SimulationOptions = {},
): { log: RunLog; sim: Simulation } {
  const sim = new Simulation(protocol, options);
  const log = RunLog.record(sim.bus);
  sim.runToEnd();
  return { log, sim };
}
