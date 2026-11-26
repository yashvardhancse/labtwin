// Interop proof: a recording written by the Python/ROS 2 side (labtwin_sim)
// opens and replays in the browser twin, because both use the same topic names,
// JSON schemas and MCAP layout.
//
//   python -m labtwin_sim.run standard .artifacts/py-standard.mcap   # (venv)
//   npm run dev                                                      # another terminal
//   node scripts/ros2-interop.mjs .artifacts/py-standard.mcap
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BASE_URL, launch } from './browser.mjs';

const file = resolve(process.argv[2] ?? '.artifacts/py-standard.mcap');
if (!existsSync(file)) {
  console.error(`Recording not found: ${file}\nRun the Python side first (see the header of this script).`);
  process.exit(2);
}

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const fail = (m) => {
  throw new Error(m);
};
const text = async (sel) => ((await page.locator(sel).first().textContent()) ?? '').trim();

try {
  await page.goto(BASE_URL);
  await page.waitForSelector('.machine-canvas');

  console.log('- opening the Python-written .mcap in the web twin');
  await page.setInputFiles('input[type="file"][accept=".mcap"]', file);
  await page.waitForFunction(
    () => document.querySelector('.status-chip')?.textContent?.includes('Replay of'),
    undefined,
    {
      timeout: 15000,
    },
  );

  const sub = await text('.report-sub');
  if (!sub.includes('Grid prep')) fail(`report does not name the Python protocol: "${sub}"`);
  const badge = await text('.report .badge');
  if (!/Completed/.test(badge)) fail(`expected a completed run, got "${badge}"`);
  if (!(await text('.protocol-panel .banner')).includes('Read-only'))
    fail('editor is not showing the recording');

  console.log('- scrubbing: the 3D machine follows the Python-recorded state');
  await page.getByRole('button', { name: /Pause the replay|Play the replay/ }).click();
  const seek = (ms) =>
    page.evaluate((v) => {
      const i = document.querySelector('.timeline-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, String(v));
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, ms);
  await seek(0);
  await page.waitForTimeout(150);
  const atStart = await text('.readouts .readout .num');
  await seek(15000);
  await page.waitForTimeout(150);
  const atEnd = await text('.readouts .readout .num');
  if (atStart === atEnd) fail('the 3D readouts did not change when scrubbing');

  if (errors.length) fail(`browser errors:\n${errors.join('\n')}`);
  console.log(
    `Interop OK: ${process.argv[2] ?? '.artifacts/py-standard.mcap'} (written by Python) replays in the web twin.`,
  );
} catch (err) {
  console.error(`Interop FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
