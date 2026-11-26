import type { Bus } from '../bus.ts';
import type { MachineConfig } from '../machine.ts';
import { describeStep, fmt, type DispenseStep, type Protocol, type Step } from '../protocol.ts';
import type { DiagnosticLevel, StepStatus } from '../topics.ts';
import type { Response } from './common.ts';
import type { GantryDriver } from './gantry.ts';
import type { PumpDriver } from './pump.ts';
import type { StageController } from './stage.ts';

export type ExecutorState = 'idle' | 'running' | 'succeeded' | 'aborted' | 'canceled';

interface ActiveStep {
  step: Step;
  startedMs: number;
  /** Dispense only: holding until the stage is cold enough. */
  holdingForStage: boolean;
  waitUntilMs: number;
}

type Poll = 'running' | 'done' | 'failed';

/**
 * Protocol executor node: walks the validated steps and drives the other nodes
 * through their action/service interfaces, publishing `/protocol/step`
 * transitions and `/diagnostics`. It re-checks preconditions at run time
 * (defence in depth): a dispense holds until the stage is actually cold and
 * aborts if it never gets there.
 */
export class ProtocolExecutor {
  readonly name = 'protocol_executor';
  state: ExecutorState = 'idle';

  readonly #protocol: Protocol;
  readonly #gantry: GantryDriver;
  readonly #pump: PumpDriver;
  readonly #stage: StageController;
  readonly #m: MachineConfig;
  readonly #bus: Bus;
  #index = -1;
  #active: ActiveStep | null = null;
  #succeeded = 0;

  constructor(
    protocol: Protocol,
    nodes: { gantry: GantryDriver; pump: PumpDriver; stage: StageController },
    machine: MachineConfig,
    bus: Bus,
  ) {
    this.#protocol = protocol;
    this.#gantry = nodes.gantry;
    this.#pump = nodes.pump;
    this.#stage = nodes.stage;
    this.#m = machine;
    this.#bus = bus;
  }

  get stepsSucceeded(): number {
    return this.#succeeded;
  }

  get activeStep(): Step | null {
    return this.#active?.step ?? null;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'running';
    const n = this.#protocol.steps.length;
    this.#diagnose('OK', `Running "${this.#protocol.name}" (${n} step${n === 1 ? '' : 's'}).`);
  }

  tick(nowMs: number): void {
    if (this.state !== 'running') return;
    if (this.#active) {
      const result = this.#poll(this.#active, nowMs);
      if (result !== 'done') return;
      this.#finish('succeeded');
    }
    this.#startNext(nowMs);
  }

  /** Stop requested by the operator. */
  cancel(): void {
    if (this.state !== 'running') return;
    const active = this.#active;
    if (active) this.#publishStep(active.step, 'canceled');
    this.#halt();
    this.state = 'canceled';
    this.#diagnose(
      'WARN',
      active
        ? `Run stopped by the operator during step ${active.step.index + 1}.`
        : 'Run stopped by the operator.',
    );
  }

  abort(reason: string): void {
    if (this.state !== 'running') return;
    if (this.#active) this.#publishStep(this.#active.step, 'aborted');
    this.#halt();
    this.state = 'aborted';
    this.#diagnose('ERROR', reason);
  }

  #startNext(nowMs: number): void {
    this.#index++;
    const step = this.#protocol.steps[this.#index];
    if (!step) {
      this.state = 'succeeded';
      const n = this.#protocol.steps.length;
      this.#diagnose('OK', `Protocol finished: ${this.#succeeded} of ${n} steps succeeded.`);
      return;
    }
    const active: ActiveStep = { step, startedMs: nowMs, holdingForStage: false, waitUntilMs: 0 };
    this.#active = active;
    this.#publishStep(step, 'executing');

    switch (step.type) {
      case 'home':
        this.#require(this.#gantry.sendGoal({ kind: 'home' }));
        break;
      case 'move':
        this.#require(this.#gantry.sendGoal({ kind: 'move', target: step.target, speed: step.speed }));
        break;
      case 'aspirate':
        this.#require(this.#pump.call({ op: 'aspirate', volumeNl: step.volumeNl, rateNlS: step.rateNlS }));
        break;
      case 'dispense':
        if (this.#stageReady()) {
          this.#startDispense(step);
        } else {
          active.holdingForStage = true;
          this.#diagnose(
            'OK',
            `Dispense holding until the stage reaches ${fmt(this.#readyBelowC())} °C (now ${fmt(this.#stage.temperatureC)} °C).`,
          );
        }
        break;
      case 'wait':
        active.waitUntilMs = nowMs + step.ms;
        break;
      case 'cool_stage':
        this.#require(this.#stage.setTarget(step.targetC));
        break;
    }
  }

  #poll(active: ActiveStep, nowMs: number): Poll {
    const step = active.step;
    switch (step.type) {
      case 'home':
      case 'move':
        if (this.#gantry.goalState === 'succeeded') return 'done';
        if (this.#gantry.goalState === 'aborted') {
          this.abort(`Motion goal for step ${step.index + 1} was aborted.`);
          return 'failed';
        }
        return 'running';
      case 'aspirate':
        return this.#pump.busy ? 'running' : 'done';
      case 'dispense':
        if (active.holdingForStage) {
          if (this.#stageReady()) {
            active.holdingForStage = false;
            this.#diagnose('OK', `Stage at ${fmt(this.#stage.temperatureC)} °C, dispensing.`);
            return this.#startDispense(step) ? 'running' : 'failed';
          }
          if (nowMs - active.startedMs > this.#m.stage.maxWaitS * 1000) {
            this.abort(
              `The stage did not reach ${fmt(this.#readyBelowC())} °C within ${this.#m.stage.maxWaitS} s; dispense aborted.`,
            );
            return 'failed';
          }
          return 'running';
        }
        return this.#pump.busy ? 'running' : 'done';
      case 'wait':
        return nowMs >= active.waitUntilMs ? 'done' : 'running';
      case 'cool_stage':
        return !step.wait || this.#stage.atTarget() ? 'done' : 'running';
    }
  }

  #startDispense(step: DispenseStep): boolean {
    return this.#require(this.#pump.call({ op: 'dispense', volumeNl: step.volumeNl, rateNlS: step.rateNlS }));
  }

  /** The grid must be both near the set-point and cold enough to vitrify the sample. */
  #readyBelowC(): number {
    return Math.min(this.#stage.targetC + this.#m.stage.toleranceC, this.#m.stage.coldEnoughC);
  }

  #stageReady(): boolean {
    return this.#stage.temperatureC <= this.#readyBelowC();
  }

  /** Abort the run if a goal/service request was rejected. */
  #require(response: Response): boolean {
    if (response.accepted) return true;
    const step = this.#active?.step;
    this.abort(`Step ${(step?.index ?? 0) + 1} was rejected: ${response.reason ?? 'unknown reason'}`);
    return false;
  }

  #finish(status: StepStatus): void {
    const active = this.#active;
    if (!active) return;
    this.#publishStep(active.step, status);
    if (status === 'succeeded') this.#succeeded++;
    this.#active = null;
  }

  #halt(): void {
    this.#gantry.cancel();
    this.#pump.stop();
    this.#active = null;
  }

  #publishStep(step: Step, status: StepStatus): void {
    this.#bus.publish('/protocol/step', {
      index: step.index,
      type: step.type,
      status,
      line: step.line,
      label: describeStep(step),
    });
  }

  #diagnose(level: DiagnosticLevel, message: string): void {
    this.#bus.publish('/diagnostics', { level, name: this.name, message });
  }
}
