// Screenshots for the README and for visual review (desktop, laptop, mobile).
//
//   npm run dev            # in another terminal
//   npm run screenshots    # writes docs/screenshots/*.png
import { mkdirSync } from 'node:fs';
import { BASE_URL, launch, waitForRunToFinish } from './browser.mjs';

const OUT = process.argv[2] ?? 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await launch();
const errors = [];
const shoot = async (name, { width, height, scale = 1, mobile = false }, act) => {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(`${name}: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${name}: ${msg.text()}`);
  });
  await page.goto(BASE_URL);
  await page.waitForSelector('.machine-canvas');
  await act(page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
  await context.close();
};

// Desktop, mid-run: the head is on its way and the stage is frosting up.
await shoot('desktop-running', { width: 1440, height: 900 }, async (page) => {
  await page.waitForTimeout(3200);
});
// Desktop, after the demo run: report, charts, droplet.
await shoot('desktop', { width: 1440, height: 900 }, async (page) => {
  await waitForRunToFinish(page);
  await page.waitForTimeout(400);
});
// Typical laptop.
await shoot('laptop', { width: 1366, height: 768 }, async (page) => {
  await waitForRunToFinish(page);
  await page.waitForTimeout(400);
});
// The validator on the broken example.
await shoot('validator', { width: 1440, height: 900 }, async (page) => {
  await waitForRunToFinish(page);
  await page.selectOption('.example-picker select', 'broken');
  await page.waitForTimeout(300);
});
// Phone.
await shoot('mobile', { width: 390, height: 844, scale: 2, mobile: true }, async (page) => {
  await page.waitForTimeout(3600);
});
// Architecture page.
await shoot('architecture', { width: 1440, height: 900 }, async (page) => {
  await page.click('a[href="#/ros2"]');
  await page.waitForSelector('.arch-diagram');
  await page.waitForTimeout(200);
});

await browser.close();
if (errors.length > 0) {
  console.error('Browser errors:\n' + errors.join('\n'));
  process.exitCode = 1;
}
