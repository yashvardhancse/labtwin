// Shared headless-browser setup for the screenshot and end-to-end scripts.
// Uses an installed Chrome or Edge through playwright-core (no browser download).
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep the temporary browser profile inside the project (.tmp is git-ignored).
const tmp = resolve('.tmp/browser');
mkdirSync(tmp, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = tmp;

const { chromium } = await import('playwright-core');

export const BASE_URL = process.env.LABTWIN_URL ?? 'http://127.0.0.1:5173/';

export async function launch() {
  const args = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  for (const channel of [process.env.BROWSER_CHANNEL, 'chrome', 'msedge'].filter(Boolean)) {
    try {
      return await chromium.launch({ channel, args });
    } catch {
      // try the next installed browser
    }
  }
  throw new Error('No Chrome or Edge found. Install one, or set BROWSER_CHANNEL.');
}

/** Wait until the demo run (or any run) has finished and the report shows its outcome. */
export async function waitForRunToFinish(page, timeout = 60_000) {
  await page.waitForFunction(
    () => document.querySelector('.report .badge')?.textContent?.match(/Completed|Stopped|Aborted/),
    undefined,
    { timeout },
  );
}
