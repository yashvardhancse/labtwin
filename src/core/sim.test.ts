import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './examples.ts';
import { DEFAULT_MACHINE } from './machine.ts';
import type { Protocol } from './protocol.ts';
import { summarizeRun } from './report.ts';
import { extractDroplets } from './scene.ts';
import { Simulation, simulate } from './sim.ts';
import { validateProtocol } from './validate.ts';

const STANDARD = EXAMPLES[0]?.source ?? '';

function compile(source: string): Protocol {
  const result = validateProtocol(source);
  if (!result.protocol) throw new Error(result.diagnostics.map((d) => d.message).join('\n'));
  return result.protocol;
}

describe('simulation determinism', () => {
  it('produces bit-identical messages for the same protocol and seed', () => {
    const a = simulate(compile(STANDARD), { seed: 7 }).log;
    const b = simulate(compile(STANDARD), { seed: 7 }).log;
    expect(a.messageCount).toBeGreaterThan(1000);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('changes only the sensor noise when the seed changes', () => {
    const a = simulate(compile(STANDARD), { seed: 1 }).log;
    const b = simulate(compile(STANDARD), { seed: 2 }).log;
    const ax = a.series('/axis/x/state').msgs;
    const bx = b.series('/axis/x/state').msgs;
    expect(ax.length).toBe(bx.length);
    // Commanded trajectory is noise-free, so it is identical…
    expect(ax.map((m) => m.cmd_mm)).toEqual(bx.map((m) => m.cmd_mm));
    // …while the measured positions differ by encoder noise only.
    const differing = ax.filter((m, i) => m.actual_mm !== bx[i]?.actual_mm).length;
    expect(differing / ax.length).toBeGreaterThan(0.5);
    const maxDiff = Math.max(...ax.map((m, i) => Math.abs(m.actual_mm - (bx[i]?.actual_mm ?? 0))));
    expect(maxDiff).toBeLessThan(0.02);
  });
});

describe('simulation behaviour', () => {
  const { log, sim } = simulate(compile(STANDARD), { seed: 42 });
  const report = summarizeRun(log, sim.protocol.steps.length);

  it('runs the standard protocol to completion', () => {
    expect(sim.executor.state).toBe('succeeded');
    expect(report.outcome).toBe('succeeded');
    expect(report.stepsSucceeded).toBe(sim.protocol.steps.length);
    expect(report.durationMs).toBeGreaterThan(10_000);
    expect(report.durationMs).toBeLessThan(30_000);
  });

  it('ends where the protocol says, with the tip retracted', () => {
    const last = (topic: '/axis/x/state' | '/axis/y/state' | '/axis/z/state') =>
      log.series(topic).msgs.at(-1);
    expect(last('/axis/x/state')?.cmd_mm).toBe(40);
    expect(last('/axis/y/state')?.cmd_mm).toBe(25);
    expect(last('/axis/z/state')?.cmd_mm).toBe(30);
    expect(Math.abs((last('/axis/z/state')?.actual_mm ?? 0) - 30)).toBeLessThan(0.01);
  });

  it('keeps the pump bookkeeping exact: 4 nL in, 3 nL out, 1 nL left, one droplet on G1', () => {
    expect(report.pump).toEqual({ aspiratedNl: 4, dispensedNl: 3, remainingNl: 1 });
    const droplets = extractDroplets(log);
    expect(droplets).toHaveLength(1);
    expect(droplets[0]?.x).toBeCloseTo(40, 1);
    expect(droplets[0]?.y).toBeCloseTo(25, 1);
  });

  it('cools the stage along an exponential curve to the set-point', () => {
    const temps = log.series('/stage/temperature').msgs;
    expect(temps[0]?.celsius).toBeCloseTo(DEFAULT_MACHINE.stage.ambientC, 0);
    expect(Math.abs((temps.at(-1)?.celsius ?? 0) + 170)).toBeLessThan(1);
    // Monotonic cooling apart from sensor noise.
    for (let i = 1; i < temps.length; i++) {
      expect(temps[i]?.celsius ?? 0).toBeLessThanOrEqual((temps[i - 1]?.celsius ?? 0) + 0.3);
    }
  });

  it('publishes axes at 100 Hz and the stage at 10 Hz', () => {
    const seconds = log.durationMs / 1000;
    expect(log.series('/axis/x/state').t.length).toBeCloseTo(seconds * 100 + 1, -1);
    expect(log.series('/stage/temperature').t.length).toBeCloseTo(seconds * 10 + 2, -1);
  });

  it('follows the commanded trajectory to within tens of micrometres', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(report.tracking[axis].maxUm).toBeGreaterThan(1); // the servo model is not ideal…
      expect(report.tracking[axis].maxUm).toBeLessThan(120); // …but it is a precision stage
    }
  });

  it('does not dispense before the stage is cold enough', () => {
    const pump = log.series('/pump/state');
    const firstDispense = pump.t[pump.msgs.findIndex((m) => m.mode === 'dispensing')] ?? -1;
    expect(firstDispense).toBeGreaterThan(0);
    const temperatureThen = log.latest('/stage/temperature', firstDispense)?.celsius ?? 0;
    expect(temperatureThen).toBeLessThanOrEqual(-167);
  });
});

describe('runtime safety checks (defence in depth)', () => {
  it('holds a dispense until the stage is cold, then continues', () => {
    // No validator here: the executor must enforce this by itself.
    const protocol: Protocol = {
      name: 'Hold test',
      source: '',
      steps: [
        { index: 0, line: 3, type: 'cool_stage', targetC: -170, wait: false },
        { index: 1, line: 4, type: 'aspirate', volumeNl: 1, rateNlS: 5 },
        { index: 2, line: 5, type: 'dispense', volumeNl: 1, rateNlS: 5 },
      ],
    };
    const { log, sim } = simulate(protocol, { seed: 1 });
    expect(sim.executor.state).toBe('succeeded');
    const messages = log.series('/diagnostics').msgs.map((m) => m.message);
    expect(messages.some((m) => m.startsWith('Dispense holding until the stage reaches'))).toBe(true);
  });

  it('aborts with an error when the stage never gets cold enough', () => {
    const protocol: Protocol = {
      name: 'Warm stage',
      source: '',
      steps: [
        { index: 0, line: 3, type: 'cool_stage', targetC: -100, wait: true },
        { index: 1, line: 4, type: 'aspirate', volumeNl: 1, rateNlS: 5 },
        { index: 2, line: 5, type: 'dispense', volumeNl: 1, rateNlS: 5 },
      ],
    };
    const machine = { ...DEFAULT_MACHINE, stage: { ...DEFAULT_MACHINE.stage, maxWaitS: 2 } };
    const { log, sim } = simulate(protocol, { seed: 1, machine });
    expect(sim.executor.state).toBe('aborted');
    const report = summarizeRun(log, 3);
    expect(report.outcome).toBe('aborted');
    expect(report.stoppedAt?.index).toBe(2);
    expect(report.issues.at(-1)?.level).toBe('ERROR');
    expect(report.pump.dispensedNl).toBe(0);
  });

  it('records an operator stop as a canceled step', () => {
    const sim = new Simulation(compile(STANDARD), { seed: 5 });
    const recorded: string[] = [];
    sim.bus.subscribe((e) => {
      if (e.topic === '/protocol/step') recorded.push(e.msg.status);
    });
    sim.start();
    for (let i = 0; i < 150; i++) sim.step();
    sim.cancel();
    expect(sim.executor.state).toBe('canceled');
    expect(recorded.at(-1)).toBe('canceled');
    expect(sim.done).toBe(true);
  });
});
