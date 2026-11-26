import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './examples.ts';
import { validateProtocol, type DiagnosticCode } from './validate.ts';

/** Build a protocol from step lines; step N is on source line N + 2. */
const protocol = (...steps: string[]) => `name: Test\nsteps:\n${steps.map((s) => `  - ${s}\n`).join('')}`;

/** Steps that leave the machine homed, the stage cold and 5 nL in the syringe. */
const READY = [
  'home: {}',
  'cool_stage: { target_c: -170 }',
  'move: { x: 100, y: 60, z: 4, speed: 15 }',
  'aspirate: { volume_nl: 5 }',
  'move: { z: 30 }',
];
const ON_GRID = 'move: { x: 40, y: 25, z: 2, speed: 10 }';
const RETRACT = 'move: { z: 30 }';

const example = (id: string) => {
  const found = EXAMPLES.find((e) => e.id === id);
  if (!found) throw new Error(`no example ${id}`);
  return found.source;
};
const codes = (source: string) => validateProtocol(source).diagnostics.map((d) => d.code);
const find = (source: string, code: DiagnosticCode) => {
  const d = validateProtocol(source).diagnostics.find((x) => x.code === code);
  if (!d) throw new Error(`expected a ${code} diagnostic, got: ${codes(source).join(', ') || 'none'}`);
  return d;
};

describe('validateProtocol: valid protocols', () => {
  it('accepts the standard and series examples without any diagnostics', () => {
    for (const id of ['standard', 'series']) {
      const result = validateProtocol(example(id));
      expect(result.diagnostics).toEqual([]);
      expect(result.protocol).not.toBeNull();
    }
  });

  it('normalises steps, fills defaults and keeps source lines', () => {
    const result = validateProtocol(
      protocol('home: {}', 'move: { z: 30 }', 'cool_stage: { target_c: -170, wait: false }'),
    );
    expect(result.protocol?.name).toBe('Test');
    expect(result.protocol?.steps).toEqual([
      { index: 0, line: 3, type: 'home' },
      { index: 1, line: 4, type: 'move', target: { z: 30 }, speed: 20 },
      { index: 2, line: 5, type: 'cool_stage', targetC: -170, wait: false },
    ]);
  });

  it('plans the tool-tip path: power-on, homing (Z first), then moves', () => {
    const result = validateProtocol(protocol('home: {}', 'move: { x: 10, y: 20 }', 'move: { z: 15 }'));
    expect(result.path.map((p) => [p.stepIndex, p.position])).toEqual([
      [-1, { x: 64, y: 46, z: 22 }],
      [0, { x: 64, y: 46, z: 40 }],
      [0, { x: 0, y: 0, z: 40 }],
      [1, { x: 10, y: 20, z: 40 }],
      [2, { x: 10, y: 20, z: 15 }],
    ]);
  });

  it('lets a protocol with only warnings run', () => {
    const result = validateProtocol(example('quick'));
    expect(result.errorCount).toBe(0);
    expect(codes(example('quick'))).toEqual(['aspirate-outside-vial']);
    expect(result.protocol).not.toBeNull();
  });
});

describe('validateProtocol: one test per error class', () => {
  it.each<[DiagnosticCode, string, number]>([
    ['yaml-syntax', 'name: x\nsteps:\n  - move: { x: 40, y: 25\n  - home: {}\n', 4],
    ['root-shape', '- home: {}\n', 1],
    ['no-steps', 'name: Nothing to do\n', 1],
    ['step-shape', protocol('home: {}', 'just some text'), 4],
    ['unknown-step', protocol('home: {}', 'dispence: { volume_nl: 1 }'), 4],
    ['unknown-field', protocol('home: {}', 'move: { x: 10, sped: 5 }'), 4],
    ['missing-field', protocol(...READY, 'dispense: {}'), 8],
    ['field-type', protocol('home: {}', 'wait: { ms: half a second }'), 4],
    ['empty-move', protocol('home: {}', 'move: { speed: 10 }'), 4],
    ['axis-limit', protocol('home: {}', 'move: { x: 140 }'), 4],
    ['speed-limit', protocol('home: {}', 'move: { x: 10, speed: 250 }'), 4],
    ['volume-limit', protocol('home: {}', 'aspirate: { volume_nl: 12 }'), 4],
    ['rate-limit', protocol('home: {}', 'aspirate: { volume_nl: 2, rate_nl_s: 50 }'), 4],
    ['temperature-range', protocol('cool_stage: { target_c: -250 }'), 3],
    ['wait-range', protocol('wait: { ms: 0 }'), 3],
    ['not-homed', protocol('move: { x: 10 }', 'home: {}'), 3],
    ['syringe-overflow', protocol(...READY, 'aspirate: { volume_nl: 6 }'), 8],
    ['syringe-empty', protocol(...READY, ON_GRID, 'dispense: { volume_nl: 6 }', RETRACT), 9],
    [
      'stage-not-cold',
      protocol(
        'home: {}',
        'move: { x: 100, y: 60, z: 4 }',
        'aspirate: { volume_nl: 4 }',
        ON_GRID,
        'dispense: { volume_nl: 2 }',
        RETRACT,
      ),
      7,
    ],
  ])('%s', (code, source, line) => {
    const result = validateProtocol(source);
    const diagnostic = result.diagnostics.find((d) => d.code === code);
    expect(diagnostic, `diagnostics: ${codes(source).join(', ')}`).toBeDefined();
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.line).toBe(line);
    expect(diagnostic?.message.length).toBeGreaterThan(10);
    expect(result.protocol).toBeNull();
  });

  it('rejects a stage set-point that is too warm for dispensing', () => {
    const d = find(
      protocol(
        'home: {}',
        'cool_stage: { target_c: -20 }',
        'move: { x: 100, y: 60, z: 4 }',
        'aspirate: { volume_nl: 4 }',
        ON_GRID,
        'dispense: { volume_nl: 2 }',
        RETRACT,
      ),
      'stage-not-cold',
    );
    expect(d.message).toContain('−20 °C');
    expect(d.hint).toContain('-150');
  });

  it('suggests the closest step type and field name', () => {
    expect(find(protocol('home: {}', 'dispence: { volume_nl: 1 }'), 'unknown-step').message).toContain(
      'Did you mean `dispense`?',
    );
    expect(find(protocol('home: {}', 'move: { x: 10, sped: 5 }'), 'unknown-field').message).toContain(
      'Did you mean `speed`?',
    );
    expect(find('name: x\nstep:\n  - home: {}\n', 'unknown-field').message).toContain(
      'Did you mean `steps`?',
    );
  });

  it('points at the offending token, in flow and in block style', () => {
    const flow = protocol('home: {}', 'move: { x: 140, y: 20 }');
    const d1 = find(flow, 'axis-limit');
    expect(flow.slice(d1.from, d1.to)).toBe('140');
    expect([d1.line, d1.column]).toEqual([4, 16]);

    const block = 'name: Block\nsteps:\n  - home: {}\n  - move:\n      y: 20\n      x: 140\n';
    const d2 = find(block, 'axis-limit');
    expect(block.slice(d2.from, d2.to)).toBe('140');
    expect(d2.line).toBe(6);
  });

  it('explains how to fix each problem', () => {
    expect(find(protocol('move: { x: 10 }', 'home: {}'), 'not-homed').hint).toBe(
      'Add `- home: {}` before the first move.',
    );
    expect(find(protocol('home: {}', 'move: { x: 140 }'), 'axis-limit').message).toBe(
      'X 140 mm is outside the travel range 0–120 mm.',
    );
  });

  it('does not cascade: a bad axis value does not also trigger position warnings', () => {
    const source = protocol('home: {}', 'move: { x: 140, y: 25, z: 2 }', 'aspirate: { volume_nl: 2 }');
    expect(codes(source)).toEqual(['axis-limit']);
  });

  it('reports the "move before home" error only once', () => {
    expect(codes(protocol('move: { x: 1 }', 'move: { x: 2 }', 'home: {}'))).toEqual(['not-homed']);
  });

  it('catches every planted mistake in the broken example', () => {
    expect(new Set(codes(example('broken')))).toEqual(
      new Set<DiagnosticCode>([
        'not-homed',
        'axis-limit',
        'unknown-step',
        'syringe-empty',
        'stage-not-cold',
        'speed-limit',
        'field-type',
        'temperature-range',
      ]),
    );
  });
});

describe('validateProtocol: warnings', () => {
  it.each<[DiagnosticCode, string]>([
    ['missing-name', 'steps:\n  - home: {}\n'],
    ['speed-capped', protocol('home: {}', 'move: { z: 10, speed: 80 }')],
    [
      'fast-approach',
      protocol(
        ...READY,
        'move: { x: 40, y: 25, z: 8 }',
        'move: { z: 2, speed: 30 }',
        'dispense: { volume_nl: 1 }',
        RETRACT,
      ),
    ],
    ['aspirate-outside-vial', protocol('home: {}', 'aspirate: { volume_nl: 2 }')],
    [
      'dispense-off-grid',
      protocol(...READY, 'move: { x: 45, y: 25, z: 2, speed: 10 }', 'dispense: { volume_nl: 1 }', RETRACT),
    ],
    [
      'dispense-high',
      protocol(...READY, 'move: { x: 40, y: 25, z: 20 }', 'dispense: { volume_nl: 1 }', RETRACT),
    ],
    ['no-retract', protocol(...READY, ON_GRID, 'dispense: { volume_nl: 1 }')],
  ])('%s', (code, source) => {
    const result = validateProtocol(source);
    expect(result.diagnostics.map((d) => d.code)).toEqual([code]);
    expect(result.diagnostics[0]?.severity).toBe('warning');
    expect(result.protocol).not.toBeNull();
  });
});
