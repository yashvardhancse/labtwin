import {
  DEFAULT_MACHINE,
  gridAt,
  homePosition,
  tipInVial,
  type MachineConfig,
  type Vec3,
} from './machine.ts';
import {
  STEP_TYPES,
  fmt,
  isStepType,
  stepSpecs,
  type FieldSpec,
  type Protocol,
  type Step,
  type StepSpec,
  type StepType,
} from './protocol.ts';
import { planLinearMove } from './trajectory.ts';
import { lineColumn, lineStarts, parseYaml, type Span, type YamlDocument } from './yamlSource.ts';

/**
 * Protocol validator — pure, deterministic and framework-free.
 *
 * Phase 1 checks structure and every field against the step specs.
 * Phase 2 "dry-runs" the protocol against a static machine model (homed?
 * where is the tip? how much is in the syringe? how cold is the stage?) to catch
 * ordering and physical mistakes before anything moves.
 *
 * Every diagnostic carries a source span, says exactly what is wrong and, in
 * `hint`, how to fix it.
 */

export type Severity = 'error' | 'warning';

export type DiagnosticCode =
  | 'yaml-syntax'
  | 'root-shape'
  | 'missing-name'
  | 'no-steps'
  | 'step-shape'
  | 'unknown-step'
  | 'unknown-field'
  | 'missing-field'
  | 'field-type'
  | 'empty-move'
  | 'axis-limit'
  | 'speed-limit'
  | 'volume-limit'
  | 'rate-limit'
  | 'temperature-range'
  | 'wait-range'
  | 'not-homed'
  | 'syringe-overflow'
  | 'syringe-empty'
  | 'stage-not-cold'
  | 'speed-capped'
  | 'fast-approach'
  | 'aspirate-outside-vial'
  | 'dispense-off-grid'
  | 'dispense-high'
  | 'no-retract';

export interface Diagnostic {
  severity: Severity;
  code: DiagnosticCode;
  /** What is wrong. */
  message: string;
  /** How to fix it. */
  hint?: string;
  /** Source span (offsets) the diagnostic points at. */
  from: number;
  to: number;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  stepIndex?: number;
}

/** A point on the planned tool-tip path; `stepIndex` −1 is the power-on position. */
export interface Waypoint {
  stepIndex: number;
  position: Vec3;
}

export interface ValidationResult {
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  /** The normalised protocol, present only when there are no errors. */
  protocol: Protocol | null;
  /** Planned tool-tip path (power-on → homing → moves), for the 3D preview. */
  path: Waypoint[];
}

const ROOT_KEYS = ['name', 'description', 'steps'];

const RANGE_CODES: Record<string, DiagnosticCode> = {
  x: 'axis-limit',
  y: 'axis-limit',
  z: 'axis-limit',
  speed: 'speed-limit',
  volume_nl: 'volume-limit',
  rate_nl_s: 'rate-limit',
  target_c: 'temperature-range',
  ms: 'wait-range',
};

type FieldValues = Partial<Record<string, number | boolean>>;

/** A step after phase 1: type known, fields that passed their checks in `values`. */
interface CheckedStep {
  index: number;
  type: StepType;
  line: number;
  typeSpan: Span;
  values: FieldValues;
  /** Fields that were present but invalid (so later checks must not guess them). */
  invalid: Set<string>;
  fieldSpan(name: string): Span;
  ok: boolean;
}

class Collector {
  readonly diagnostics: Diagnostic[] = [];
  readonly #starts: number[];
  readonly #length: number;

  constructor(source: string) {
    this.#starts = lineStarts(source);
    this.#length = source.length;
  }

  report(
    severity: Severity,
    code: DiagnosticCode,
    span: Span,
    message: string,
    hint?: string,
    step?: number,
  ) {
    const from = Math.min(Math.max(0, span.from), this.#length);
    const to = Math.min(Math.max(from, span.to), this.#length);
    const { line, column } = lineColumn(this.#starts, from);
    this.diagnostics.push({
      severity,
      code,
      message,
      ...(hint !== undefined ? { hint } : {}),
      from,
      to,
      line,
      column,
      ...(step !== undefined ? { stepIndex: step } : {}),
    });
  }

  lineOf(offset: number): number {
    return lineColumn(this.#starts, offset).line;
  }

  get errorCount(): number {
    return this.diagnostics.filter((d) => d.severity === 'error').length;
  }
}

export function validateProtocol(source: string, machine: MachineConfig = DEFAULT_MACHINE): ValidationResult {
  const out = new Collector(source);
  const specs = stepSpecs(machine);
  const finish = (protocol: Protocol | null, path: Waypoint[]): ValidationResult => {
    const diagnostics = [...out.diagnostics].sort(
      (a, b) => a.from - b.from || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1),
    );
    const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
    return {
      diagnostics,
      errorCount,
      warningCount: diagnostics.length - errorCount,
      protocol: errorCount === 0 ? protocol : null,
      path,
    };
  };

  const parsed = parseYaml(source);
  if (!parsed.ok) {
    out.report(
      'error',
      'yaml-syntax',
      { from: parsed.offset, to: parsed.offset + 1 },
      parsed.message,
      'The protocol checks run once the YAML parses.',
    );
    return finish(null, []);
  }
  const doc = parsed.doc;
  const root = doc.value;
  const rootSpan = doc.locate([])?.value ?? { from: 0, to: 0 };

  if (root === null || root === undefined) {
    out.report(
      'error',
      'no-steps',
      { from: 0, to: 0 },
      'The protocol is empty.',
      'Start with `name:` and a `steps:` list, or pick an example from the menu.',
    );
    return finish(null, []);
  }
  if (!isRecord(root)) {
    out.report(
      'error',
      'root-shape',
      rootSpan,
      `A protocol must be a mapping with \`name\` and \`steps\`, not ${describeValue(root)}.`,
      'Start the file with `name: My protocol` followed by `steps:`.',
    );
    return finish(null, []);
  }

  for (const key of Object.keys(root)) {
    if (ROOT_KEYS.includes(key)) continue;
    const suggestion = closest(key, ROOT_KEYS);
    out.report(
      'error',
      'unknown-field',
      doc.locate([key])?.key ?? rootSpan,
      `Unknown top-level key \`${key}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
      `A protocol has ${ROOT_KEYS.map((k) => `\`${k}\``).join(', ')}.`,
    );
  }

  let name = 'Untitled protocol';
  if (root.name === undefined) {
    out.report(
      'warning',
      'missing-name',
      { from: rootSpan.from, to: rootSpan.from },
      'The protocol has no `name`.',
      'Add `name: …` at the top so recordings of this run are easy to identify.',
    );
  } else if (typeof root.name !== 'string' || root.name.trim() === '') {
    out.report(
      'error',
      'field-type',
      doc.locate(['name'])?.value ?? rootSpan,
      '`name` must be a non-empty piece of text.',
      'For example `name: Grid prep – standard`.',
    );
  } else {
    name = root.name.trim();
  }

  const steps = root.steps;
  if (steps === undefined || steps === null) {
    out.report(
      'error',
      'no-steps',
      doc.locate(['steps'])?.key ?? { from: rootSpan.from, to: rootSpan.from },
      'The protocol has no `steps`.',
      'Add `steps:` followed by one `- <step>: { … }` line per action, starting with `- home: {}`.',
    );
    return finish(null, []);
  }
  if (!Array.isArray(steps)) {
    out.report(
      'error',
      'root-shape',
      doc.locate(['steps'])?.value ?? rootSpan,
      `\`steps\` must be a list, not ${describeValue(steps)}.`,
      'Start every step on its own line with `- `, e.g. `- home: {}`.',
    );
    return finish(null, []);
  }
  if (steps.length === 0) {
    out.report(
      'error',
      'no-steps',
      doc.locate(['steps'])?.key ?? rootSpan,
      'The `steps` list is empty.',
      'Add at least `- home: {}`.',
    );
    return finish(null, []);
  }

  const checked: (CheckedStep | null)[] = steps.map((item, index) =>
    checkStep(out, doc, specs, item, index, rootSpan),
  );
  const path = dryRun(out, machine, checked);

  const protocol: Protocol = {
    name,
    source,
    steps: checked.filter((s): s is CheckedStep => s?.ok === true).map((s) => toStep(s, machine)),
  };
  return finish(protocol, path);
}

function checkStep(
  out: Collector,
  doc: YamlDocument,
  specs: Record<StepType, StepSpec>,
  item: unknown,
  index: number,
  rootSpan: Span,
): CheckedStep | null {
  const itemPath = ['steps', index];
  const itemSpan = doc.locate(itemPath)?.value ?? rootSpan;
  const n = index + 1;

  if (!isRecord(item)) {
    out.report(
      'error',
      'step-shape',
      itemSpan,
      `Step ${n} is ${describeValue(item)}, not a step.`,
      'Write each step as `- <type>: { … }`, for example `- home: {}`.',
      index,
    );
    return null;
  }
  const keys = Object.keys(item);
  const typeName = keys[0];
  if (typeName === undefined || keys.length !== 1) {
    out.report(
      'error',
      'step-shape',
      itemSpan,
      keys.length === 0
        ? `Step ${n} is empty.`
        : `Step ${n} has ${keys.length} actions (${keys.join(', ')}).`,
      'Put each action in its own `- ` list item.',
      index,
    );
    return null;
  }

  const typeLocation = doc.locate([...itemPath, typeName]);
  const typeSpan = typeLocation?.key ?? itemSpan;
  if (!isStepType(typeName)) {
    const suggestion = closest(typeName, STEP_TYPES);
    out.report(
      'error',
      'unknown-step',
      typeSpan,
      `Unknown step type \`${typeName}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
      `Valid step types are ${STEP_TYPES.map((t) => `\`${t}\``).join(', ')}.`,
      index,
    );
    return null;
  }

  const spec = specs[typeName];
  const fieldsPath = [...itemPath, typeName];
  const step: CheckedStep = {
    index,
    type: typeName,
    line: out.lineOf(typeSpan.from),
    typeSpan,
    values: {},
    invalid: new Set(),
    fieldSpan: (field) => doc.locate([...fieldsPath, field])?.value ?? typeSpan,
    ok: true,
  };
  const fail = (...args: Parameters<Collector['report']>) => {
    out.report(...args);
    step.ok = false;
  };

  const params = item[typeName];
  let fields: Record<string, unknown>;
  if (params === null || params === undefined) {
    fields = {};
  } else if (isRecord(params)) {
    fields = params;
  } else {
    fail(
      'error',
      'step-shape',
      typeLocation?.value ?? typeSpan,
      `\`${typeName}\` needs its settings as a mapping, not ${describeValue(params)}.`,
      `For example \`- ${spec.example}\`.`,
      index,
    );
    return step;
  }

  const fieldNames = spec.fields.map((f) => f.name);
  for (const key of Object.keys(fields)) {
    if (fieldNames.includes(key)) continue;
    const suggestion = closest(key, fieldNames);
    fail(
      'error',
      'unknown-field',
      doc.locate([...fieldsPath, key])?.key ?? typeSpan,
      `\`${typeName}\` has no field \`${key}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
      fieldNames.length > 0
        ? `Fields of \`${typeName}\`: ${fieldNames.map((f) => `\`${f}\``).join(', ')}.`
        : `\`${typeName}\` takes no fields; write \`- ${typeName}: {}\`.`,
      index,
    );
  }

  for (const field of spec.fields) {
    const raw = fields[field.name];
    if (raw === undefined) {
      if (field.required) {
        fail(
          'error',
          'missing-field',
          typeSpan,
          `\`${typeName}\` is missing \`${field.name}\`.`,
          `Add \`${field.name}\` (${describeRange(field)}), e.g. \`- ${spec.example}\`.`,
          index,
        );
      }
      continue;
    }
    const span = step.fieldSpan(field.name);
    if (field.kind === 'boolean') {
      if (typeof raw !== 'boolean') {
        step.invalid.add(field.name);
        fail(
          'error',
          'field-type',
          span,
          `\`${field.name}\` must be \`true\` or \`false\`, not ${describeValue(raw)}.`,
          undefined,
          index,
        );
      } else {
        step.values[field.name] = raw;
      }
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      step.invalid.add(field.name);
      fail(
        'error',
        'field-type',
        span,
        `\`${field.name}\` must be a number, not ${describeValue(raw)}.`,
        `Use a plain number${field.unit ? ` in ${field.unit}` : ''}, e.g. \`${field.name}: ${exampleValue(field)}\`.`,
        index,
      );
      continue;
    }
    const tooLow = field.min !== undefined && (field.minExclusive ? raw <= field.min : raw < field.min);
    const tooHigh = field.max !== undefined && raw > field.max;
    if (tooLow || tooHigh) {
      step.invalid.add(field.name);
      fail(
        'error',
        RANGE_CODES[field.name] ?? 'field-type',
        span,
        rangeMessage(field, raw, tooLow),
        rangeHint(field),
        index,
      );
      continue;
    }
    step.values[field.name] = raw;
  }

  if (typeName === 'move' && !['x', 'y', 'z'].some((a) => fields[a] !== undefined)) {
    fail(
      'error',
      'empty-move',
      typeSpan,
      'This move has no target.',
      'Give at least one of `x`, `y` or `z`, e.g. `- move: { z: 30 }`.',
      index,
    );
  }
  return step;
}

/** Phase 2: walk the protocol against a static model of the machine. */
function dryRun(out: Collector, m: MachineConfig, steps: (CheckedStep | null)[]): Waypoint[] {
  const path: Waypoint[] = [{ stepIndex: -1, position: { ...m.powerOn } }];
  let homed = false;
  let notHomedReported = false;
  /** Tip position, or null when it cannot be known statically. */
  let pos: Vec3 | null = null;
  let volume = 0;
  /** Stage set-point: null = never set (ambient), NaN = set but invalid. */
  let stageTarget: number | null = null;
  let last: CheckedStep | null = null;

  for (const step of steps) {
    if (step === null) continue;
    last = step;
    const v = step.values;
    switch (step.type) {
      case 'home': {
        homed = true;
        const home = homePosition(m);
        path.push({ stepIndex: step.index, position: { ...m.powerOn, z: home.z } });
        path.push({ stepIndex: step.index, position: home });
        pos = home;
        break;
      }
      case 'move': {
        if (!homed) {
          if (!notHomedReported) {
            out.report(
              'error',
              'not-homed',
              step.typeSpan,
              'This move runs before the axes are homed, so their positions are unknown.',
              'Add `- home: {}` before the first move.',
              step.index,
            );
            notHomedReported = true;
          }
          break;
        }
        const axisInvalid = ['x', 'y', 'z'].some((a) => step.invalid.has(a));
        if (pos === null || axisInvalid) {
          pos = null;
          break;
        }
        const target: Vec3 = {
          x: typeof v.x === 'number' ? v.x : pos.x,
          y: typeof v.y === 'number' ? v.y : pos.y,
          z: typeof v.z === 'number' ? v.z : pos.z,
        };
        if (!step.invalid.has('speed')) {
          const speed = typeof v.speed === 'number' ? v.speed : m.move.defaultSpeed;
          const plan = planLinearMove(pos, target, speed, m.axes);
          const speedSpan = v.speed !== undefined ? step.fieldSpan('speed') : step.typeSpan;
          if (plan.length > 0 && plan.limitingAxis && plan.effectiveSpeed < speed - 0.5) {
            const axis = plan.limitingAxis;
            out.report(
              'warning',
              'speed-capped',
              speedSpan,
              `This move will run at ${fmt(plan.effectiveSpeed)} mm/s, not ${fmt(speed)} mm/s: ${axis.toUpperCase()} is limited to ${fmt(m.axes[axis].maxSpeed)} mm/s.`,
              `Lower \`speed\` to ${fmt(Math.floor(plan.effectiveSpeed))} or split the move so ${axis.toUpperCase()} moves on its own.`,
              step.index,
            );
          }
          const approaching = target.z < m.safety.approachZ && target.z < pos.z;
          const actualSpeed = Math.min(speed, plan.effectiveSpeed);
          if (approaching && actualSpeed > m.safety.approachMaxSpeed) {
            out.report(
              'warning',
              'fast-approach',
              speedSpan,
              `The tip approaches Z ${fmt(target.z)} mm at ${fmt(actualSpeed)} mm/s.`,
              `Below Z ${fmt(m.safety.approachZ)} mm move at ${fmt(m.safety.approachMaxSpeed)} mm/s or slower (e.g. \`speed: 10\`), so the needle does not hit the grid or splash the sample.`,
              step.index,
            );
          }
        }
        pos = target;
        path.push({ stepIndex: step.index, position: target });
        break;
      }
      case 'aspirate': {
        const amount = v.volume_nl;
        if (typeof amount === 'number') {
          if (volume + amount > m.pump.capacityNl + 1e-9) {
            out.report(
              'error',
              'syringe-overflow',
              step.fieldSpan('volume_nl'),
              `Aspirating ${fmt(amount)} nL would fill the syringe to ${fmt(volume + amount)} nL; it holds ${fmt(m.pump.capacityNl)} nL.`,
              `Aspirate at most ${fmt(m.pump.capacityNl - volume)} nL here, or dispense first.`,
              step.index,
            );
          }
          volume = Math.min(m.pump.capacityNl, volume + amount);
        }
        if (pos !== null && !tipInVial(m, pos)) {
          const vial = m.deck.vial;
          out.report(
            'warning',
            'aspirate-outside-vial',
            step.typeSpan,
            `The tip is at X ${fmt(pos.x)}, Y ${fmt(pos.y)}, Z ${fmt(pos.z)}, not in the sample vial, so the pump would draw air.`,
            `Move into the vial first, e.g. \`- move: { x: ${vial.x}, y: ${vial.y}, z: ${vial.liquidZ - 2} }\`.`,
            step.index,
          );
        }
        break;
      }
      case 'dispense': {
        const amount = v.volume_nl;
        if (typeof amount === 'number') {
          if (amount > volume + 1e-9) {
            out.report(
              'error',
              'syringe-empty',
              step.fieldSpan('volume_nl'),
              volume === 0
                ? 'Nothing to dispense: the syringe is empty at this point.'
                : `Dispensing ${fmt(amount)} nL, but only ${fmt(volume)} nL is in the syringe here.`,
              volume === 0
                ? 'Add an `aspirate` step before this one.'
                : `Aspirate at least ${fmt(amount - volume)} nL more before this step, or dispense less.`,
              step.index,
            );
          }
          volume = Math.max(0, volume - amount);
        }
        if (stageTarget === null) {
          out.report(
            'error',
            'stage-not-cold',
            step.typeSpan,
            `The stage is still at room temperature (${fmt(m.stage.ambientC)} °C) when this dispense runs.`,
            `Add \`- cool_stage: { target_c: -170 }\` before dispensing; grids must be at ${fmt(m.stage.coldEnoughC)} °C or colder.`,
            step.index,
          );
        } else if (!Number.isNaN(stageTarget) && stageTarget > m.stage.coldEnoughC) {
          out.report(
            'error',
            'stage-not-cold',
            step.typeSpan,
            `The stage set-point is ${fmt(stageTarget)} °C; dispensing needs ${fmt(m.stage.coldEnoughC)} °C or colder.`,
            `Lower \`target_c\` in the \`cool_stage\` step to ${m.stage.coldEnoughC} or below.`,
            step.index,
          );
        }
        if (pos !== null) {
          if (!gridAt(m, pos.x, pos.y)) {
            const grids = m.deck.grids.map((g) => `${g.id} (${g.x}, ${g.y})`).join(', ');
            out.report(
              'warning',
              'dispense-off-grid',
              step.typeSpan,
              `The tip is at X ${fmt(pos.x)}, Y ${fmt(pos.y)}, which is not above a grid; the sample would land on the holder.`,
              `Move over a grid first. Grid centres: ${grids}.`,
              step.index,
            );
          }
          if (pos.z > m.safety.maxDispenseHeight) {
            out.report(
              'warning',
              'dispense-high',
              step.typeSpan,
              `Dispensing from Z ${fmt(pos.z)} mm: the droplet would fall onto the grid.`,
              `Lower the tip to Z ${fmt(m.safety.maxDispenseHeight)} mm or less first, e.g. \`- move: { z: 2, speed: 5 }\`.`,
              step.index,
            );
          }
        }
        break;
      }
      case 'cool_stage':
        stageTarget = typeof v.target_c === 'number' ? v.target_c : Number.NaN;
        break;
      case 'wait':
        break;
    }
  }

  if (last !== null && homed && pos !== null && pos.z < m.safety.retractZ) {
    out.report(
      'warning',
      'no-retract',
      last.typeSpan,
      `The protocol ends with the tip at Z ${fmt(pos.z)} mm, close to the sample.`,
      'Finish with `- move: { z: 30 }` to lift the needle clear.',
      last.index,
    );
  }
  return path;
}

function toStep(s: CheckedStep, m: MachineConfig): Step {
  const v = s.values;
  const num = (key: string, fallback: number) => (typeof v[key] === 'number' ? v[key] : fallback);
  const base = { index: s.index, line: s.line };
  switch (s.type) {
    case 'home':
      return { ...base, type: 'home' };
    case 'move': {
      const target: Partial<Record<'x' | 'y' | 'z', number>> = {};
      for (const a of ['x', 'y', 'z'] as const) {
        const value = v[a];
        if (typeof value === 'number') target[a] = value;
      }
      return { ...base, type: 'move', target, speed: num('speed', m.move.defaultSpeed) };
    }
    case 'aspirate':
    case 'dispense':
      return {
        ...base,
        type: s.type,
        volumeNl: num('volume_nl', 0),
        rateNlS: num('rate_nl_s', m.pump.defaultRateNlS),
      };
    case 'wait':
      return { ...base, type: 'wait', ms: num('ms', 0) };
    case 'cool_stage':
      return {
        ...base,
        type: 'cool_stage',
        targetC: num('target_c', m.stage.ambientC),
        wait: v.wait !== false,
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'empty';
  if (typeof value === 'string') return `the text "${value.length > 24 ? `${value.slice(0, 24)}…` : value}"`;
  if (typeof value === 'boolean') return `\`${value}\``;
  if (typeof value === 'number') return `the number ${value}`;
  if (Array.isArray(value)) return 'a list';
  return 'a mapping';
}

function describeRange(f: FieldSpec): string {
  if (f.kind === 'boolean') return '`true` or `false`';
  const unit = f.unit ? ` ${f.unit}` : '';
  if (f.min !== undefined && f.max !== undefined) {
    return f.minExclusive
      ? `more than ${fmt(f.min)}, up to ${fmt(f.max)}${unit}`
      : `${fmt(f.min)} to ${fmt(f.max)}${unit}`;
  }
  return `a number${unit}`;
}

function exampleValue(f: FieldSpec): string {
  if (f.example !== undefined) return String(f.example);
  if (typeof f.defaultValue === 'number') return String(f.defaultValue);
  if (f.min !== undefined && f.max !== undefined) return String(Math.round((f.min + f.max) / 2));
  return '1';
}

function rangeMessage(f: FieldSpec, value: number, tooLow: boolean): string {
  const unit = f.unit ?? '';
  switch (f.name) {
    case 'x':
    case 'y':
    case 'z':
      return `${f.name.toUpperCase()} ${fmt(value)} mm is outside the travel range ${fmt(f.min ?? 0)}–${fmt(f.max ?? 0)} mm.`;
    case 'speed':
      return tooLow
        ? 'Speed must be greater than 0 mm/s.'
        : `Speed ${fmt(value)} mm/s is above the ${fmt(f.max ?? 0)} mm/s limit.`;
    case 'target_c':
      return `${fmt(value)} °C is outside the stage range ${fmt(f.min ?? 0)} to ${fmt(f.max ?? 0)} °C.`;
    case 'ms':
      return tooLow
        ? 'A wait must be longer than 0 ms.'
        : `A wait of ${fmt(value / 1000)} s is longer than the ${fmt((f.max ?? 0) / 60000)} min limit.`;
    default:
      return `\`${f.name}\` ${fmt(value, 2)} ${unit} is outside ${describeRange(f)}.`;
  }
}

function rangeHint(f: FieldSpec): string {
  if (f.name === 'target_c')
    return `Use a set-point between ${f.min ?? ''} and ${f.max ?? ''} °C, e.g. \`target_c: -170\`.`;
  return `Use ${describeRange(f)}.`;
}

/** Closest candidate within a small edit distance, for "did you mean" hints. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  const w = word.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = editDistance(w, c.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  const limit = w.length <= 4 ? 1 : w.length <= 8 ? 2 : 3;
  return bestDistance <= limit ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}
