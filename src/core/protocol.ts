import type { AxisName, MachineConfig } from './machine.ts';

/**
 * Protocol model. A protocol is a YAML document with a `name` and a list of
 * `steps`; each step is a single-key mapping `- <type>: { <fields> }`.
 * The validator turns source text into these normalised, typed steps.
 */

export const STEP_TYPES = ['home', 'move', 'aspirate', 'dispense', 'wait', 'cool_stage'] as const;
export type StepType = (typeof STEP_TYPES)[number];

interface StepBase {
  /** Position in the `steps` list, 0-based. */
  index: number;
  /** 1-based source line of the step, used to highlight the running step. */
  line: number;
}

export interface HomeStep extends StepBase {
  type: 'home';
}
export interface MoveStep extends StepBase {
  type: 'move';
  target: Partial<Record<AxisName, number>>;
  /** Requested path speed, mm/s. */
  speed: number;
}
export interface AspirateStep extends StepBase {
  type: 'aspirate';
  volumeNl: number;
  rateNlS: number;
}
export interface DispenseStep extends StepBase {
  type: 'dispense';
  volumeNl: number;
  rateNlS: number;
}
export interface WaitStep extends StepBase {
  type: 'wait';
  ms: number;
}
export interface CoolStageStep extends StepBase {
  type: 'cool_stage';
  targetC: number;
  /** Block until the stage reaches the target (default) or continue while it cools. */
  wait: boolean;
}

export type Step = HomeStep | MoveStep | AspirateStep | DispenseStep | WaitStep | CoolStageStep;

export interface Protocol {
  name: string;
  steps: Step[];
  /** The YAML the protocol was parsed from; stored in recordings as an attachment. */
  source: string;
}

export function isStepType(value: string): value is StepType {
  return (STEP_TYPES as readonly string[]).includes(value);
}

/** Typographic minus sign (U+2212) for negative numbers in prose. */
export const MINUS = String.fromCharCode(0x2212);

/** Typographic number formatting for prose: true minus sign, trimmed decimals. */
export function fmt(value: number, maxDecimals = 1): string {
  const rounded = Number(value.toFixed(maxDecimals));
  const text = String(Math.abs(rounded));
  return rounded < 0 ? `${MINUS}${text}` : text;
}

/** One-line, human-readable description of a step, used in the UI and in recordings. */
export function describeStep(step: Step): string {
  switch (step.type) {
    case 'home':
      return 'Home all axes';
    case 'move': {
      const parts = (['x', 'y', 'z'] as const)
        .filter((a) => step.target[a] !== undefined)
        .map((a) => `${a.toUpperCase()} ${fmt(step.target[a] ?? 0)}`);
      return `Move to ${parts.join(', ')} at ${fmt(step.speed)} mm/s`;
    }
    case 'aspirate':
      return `Aspirate ${fmt(step.volumeNl)} nL`;
    case 'dispense':
      return `Dispense ${fmt(step.volumeNl)} nL`;
    case 'wait':
      return `Wait ${fmt(step.ms / 1000, 2)} s`;
    case 'cool_stage':
      return `Cool stage to ${fmt(step.targetC)} °C${step.wait ? '' : ' (in background)'}`;
  }
}

export interface FieldSpec {
  name: string;
  kind: 'number' | 'boolean';
  required: boolean;
  unit?: string;
  min?: number;
  max?: number;
  /** `min` is exclusive (value must be strictly greater). */
  minExclusive?: boolean;
  defaultValue?: number | boolean;
  /** Value used in hints, e.g. `speed: 20`. */
  example?: number;
  doc: string;
}

export interface StepSpec {
  type: StepType;
  summary: string;
  fields: FieldSpec[];
  /** Example used by the editor's autocompletion and the docs. */
  example: string;
}

/**
 * The protocol language, described once. The validator, the editor's
 * autocompletion and the reference tables in the UI all read from this.
 */
export function stepSpecs(m: MachineConfig): Record<StepType, StepSpec> {
  const axisField = (a: AxisName): FieldSpec => ({
    name: a,
    kind: 'number',
    required: false,
    unit: 'mm',
    min: m.axes[a].min,
    max: m.axes[a].max,
    example: { x: 40, y: 25, z: 10 }[a],
    doc: `Target ${a.toUpperCase()} position of the tip`,
  });
  return {
    home: {
      type: 'home',
      summary: 'Reference all axes (Z first, then X and Y). Required before any move.',
      fields: [],
      example: 'home: {}',
    },
    move: {
      type: 'move',
      summary: 'Straight-line move of the tip. Omitted axes keep their position.',
      fields: [
        axisField('x'),
        axisField('y'),
        axisField('z'),
        {
          name: 'speed',
          kind: 'number',
          required: false,
          unit: 'mm/s',
          min: 0,
          minExclusive: true,
          max: m.move.maxSpeed,
          defaultValue: m.move.defaultSpeed,
          example: 20,
          doc: 'Path speed; capped per axis by the drive limits',
        },
      ],
      example: 'move: { x: 40, y: 25, z: 10, speed: 50 }',
    },
    aspirate: {
      type: 'aspirate',
      summary: 'Draw sample into the syringe. The tip should be in the sample vial.',
      fields: [
        {
          name: 'volume_nl',
          kind: 'number',
          required: true,
          unit: 'nL',
          min: m.pump.minVolumeNl,
          max: m.pump.maxVolumeNl,
          example: 4,
          doc: 'Volume to draw in',
        },
        {
          name: 'rate_nl_s',
          kind: 'number',
          required: false,
          unit: 'nL/s',
          min: m.pump.minRateNlS,
          max: m.pump.maxRateNlS,
          defaultValue: m.pump.defaultRateNlS,
          example: 2,
          doc: 'Pump flow rate',
        },
      ],
      example: 'aspirate: { volume_nl: 4 }',
    },
    dispense: {
      type: 'dispense',
      summary: 'Write sample onto the grid below the tip. The stage must be cold.',
      fields: [
        {
          name: 'volume_nl',
          kind: 'number',
          required: true,
          unit: 'nL',
          min: m.pump.minVolumeNl,
          max: m.pump.maxVolumeNl,
          example: 3,
          doc: 'Volume to dispense',
        },
        {
          name: 'rate_nl_s',
          kind: 'number',
          required: false,
          unit: 'nL/s',
          min: m.pump.minRateNlS,
          max: m.pump.maxRateNlS,
          defaultValue: m.pump.defaultRateNlS,
          example: 2,
          doc: 'Pump flow rate',
        },
      ],
      example: 'dispense: { volume_nl: 3 }',
    },
    wait: {
      type: 'wait',
      summary: 'Pause the protocol.',
      fields: [
        {
          name: 'ms',
          kind: 'number',
          required: true,
          unit: 'ms',
          min: 0,
          minExclusive: true,
          max: m.wait.maxMs,
          example: 500,
          doc: 'Duration',
        },
      ],
      example: 'wait: { ms: 500 }',
    },
    cool_stage: {
      type: 'cool_stage',
      summary: 'Set the cryo-stage temperature. Blocks until it is reached unless `wait: false`.',
      fields: [
        {
          name: 'target_c',
          kind: 'number',
          required: true,
          unit: '°C',
          min: m.stage.minC,
          max: m.stage.maxC,
          example: -170,
          doc: 'Stage set-point',
        },
        {
          name: 'wait',
          kind: 'boolean',
          required: false,
          defaultValue: true,
          doc: 'Wait for the stage to reach the target before the next step',
        },
      ],
      example: 'cool_stage: { target_c: -170 }',
    },
  };
}
