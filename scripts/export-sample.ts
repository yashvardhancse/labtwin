// Headless run → MCAP, using the same core as the browser app.
// Node ≥ 22.18 runs this TypeScript directly (type stripping), no build step:
//
//   node scripts/export-sample.ts [example-id] [output.mcap] [seed]
//
// CI uses it to produce a recording that the official Python MCAP reader then
// verifies (scripts/verify_mcap.py) — an independent check of the file format.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EXAMPLES } from '../src/core/examples.ts';
import { writeRecording } from '../src/core/mcap.ts';
import { fmt } from '../src/core/protocol.ts';
import { summarizeRun } from '../src/core/report.ts';
import { DEFAULT_SEED, simulate } from '../src/core/sim.ts';
import { validateProtocol } from '../src/core/validate.ts';

const [id = 'standard', output = `.artifacts/${id}.mcap`, seedArg] = process.argv.slice(2);
const example = EXAMPLES.find((e) => e.id === id);
if (!example) {
  console.error(`Unknown example "${id}". Choose one of: ${EXAMPLES.map((e) => e.id).join(', ')}`);
  process.exit(2);
}

const validation = validateProtocol(example.source);
for (const d of validation.diagnostics) console.log(`  line ${d.line}: ${d.severity}: ${d.message}`);
if (!validation.protocol) {
  console.error(`"${example.title}" has errors; nothing to run.`);
  process.exit(1);
}

const seed = seedArg === undefined ? DEFAULT_SEED : Number(seedArg);
const { log, sim } = simulate(validation.protocol, { seed });
const report = summarizeRun(log, validation.protocol.steps.length);
const bytes = await writeRecording(
  log,
  {
    protocolName: validation.protocol.name,
    seed,
    durationMs: log.durationMs,
    stepCount: validation.protocol.steps.length,
    outcome: sim.executor.state,
    startTimeNs: BigInt(Date.now()) * 1_000_000n,
    simDtMs: sim.dtMs,
  },
  { protocolYaml: example.source },
);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, bytes);

const err = report.tracking;
console.log(`${example.title}: ${report.outcome} in ${fmt(report.durationMs / 1000, 2)} s, seed ${seed}`);
console.log(
  `  steps ${report.stepsSucceeded}/${report.stepsTotal ?? '?'} · ${report.messageCount} messages on ${report.topicCount} topics`,
);
console.log(
  `  max tracking error X ${fmt(err.x.maxUm)} µm, Y ${fmt(err.y.maxUm)} µm, Z ${fmt(err.z.maxUm)} µm (RMS moving ${fmt(err.x.rmsMovingUm)}/${fmt(err.y.rmsMovingUm)}/${fmt(err.z.rmsMovingUm)})`,
);
console.log(
  `  pump: ${report.pump.aspiratedNl} nL in, ${report.pump.dispensedNl} nL out · stage min ${fmt(report.stage.minC ?? 0)} °C`,
);
for (const issue of report.issues)
  console.log(`  ${issue.level} at ${fmt(issue.t / 1000, 2)} s: ${issue.message}`);
console.log(`Wrote ${output} (${(bytes.length / 1024).toFixed(0)} KiB)`);
