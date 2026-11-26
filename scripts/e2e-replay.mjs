// End-to-end check in a real browser: run → download .mcap → open it again → replay.
//
//   npm run dev        # or: npm run build && npm run preview -- --port 5173
//   npm run e2e
import { mkdirSync } from 'node:fs';
import { BASE_URL, launch, waitForRunToFinish } from './browser.mjs';

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', (err) => browserErrors.push(err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') browserErrors.push(msg.text());
});

const step = (text) => console.log(`- ${text}`);
const fail = (text) => {
  throw new Error(text);
};
const textOf = async (selector) => ((await page.locator(selector).first().textContent()) ?? '').trim();
const readoutX = () => textOf('.readouts .readout .num');
const seek = (ms) =>
  page.evaluate((value) => {
    const input = document.querySelector('.timeline-input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, ms);

try {
  await page.goto(BASE_URL);

  step('the demo run starts by itself and completes');
  await waitForRunToFinish(page);
  if (!/Completed/.test(await textOf('.report .badge'))) fail('demo run did not complete');
  const liveFacts = await page.locator('.report-grid').innerText();
  const liveTracking = await page.locator('.report-tracking').innerText();

  step('"Download recording (.mcap)" saves a file');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download recording (.mcap)' }).click(),
  ]);
  mkdirSync('.artifacts', { recursive: true });
  const file = `.artifacts/${download.suggestedFilename()}`;
  if (!file.endsWith('.mcap')) fail(`unexpected file name ${file}`);
  await download.saveAs(file);

  step('"Open recording" loads that file into replay mode');
  await page.setInputFiles('input[type="file"][accept=".mcap"]', file);
  await page.waitForFunction(() =>
    document.querySelector('.status-chip')?.textContent?.includes('Replay of'),
  );
  if (!(await textOf('.report-sub')).includes(download.suggestedFilename()))
    fail('report does not name the file');
  if (!(await textOf('.protocol-panel .banner')).includes('Read-only'))
    fail('editor is not showing the recording');

  step('the replayed report is identical to the live run');
  if ((await page.locator('.report-grid').innerText()) !== liveFacts)
    fail('run facts differ after the round trip');
  if ((await page.locator('.report-tracking').innerText()) !== liveTracking) fail('tracking errors differ');

  step('scrubbing the timeline moves the machine');
  await page.getByRole('button', { name: /Pause the replay|Play the replay/ }).click();
  await seek(0);
  await page.waitForTimeout(150);
  const atStart = await readoutX();
  await seek(15_000);
  await page.waitForTimeout(150);
  const atEnd = await readoutX();
  if (!atStart.startsWith('64.0')) fail(`expected X ≈ 64 mm at t = 0, got ${atStart}`);
  if (!atEnd.startsWith('39.99') && !atEnd.startsWith('40.00'))
    fail(`expected X ≈ 40 mm at the end, got ${atEnd}`);

  if (browserErrors.length > 0) fail(`browser errors:\n${browserErrors.join('\n')}`);
  console.log(`E2E passed: ${file} round-trips through download, open and replay.`);
} catch (err) {
  console.error(`E2E failed: ${err instanceof Error ? err.message : String(err)}`);
  await page.screenshot({ path: '.artifacts/e2e-failure.png' });
  process.exitCode = 1;
} finally {
  await browser.close();
}
