// Copies the three official Foxglove JSON schemas LabTwin writes into its MCAP
// files from the @foxglove/schemas package (a devDependency) into src/, so the
// app bundles ~30 kB instead of the package's full 326 kB schema index.
// A unit test fails if the vendored copy ever drifts from the package.
//
//   node scripts/vendor-foxglove-schemas.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const all = require('@foxglove/schemas/jsonschema');

const NAMES = ['FrameTransforms', 'SceneUpdate', 'Log'];
const vendored = Object.fromEntries(NAMES.map((name) => [`foxglove.${name}`, all[name]]));

const target = new URL('../src/core/foxglove/schemas.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(vendored)}\n`);
console.log(`Wrote ${NAMES.length} schemas to src/core/foxglove/schemas.json`);
