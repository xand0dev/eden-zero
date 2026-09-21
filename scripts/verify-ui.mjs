/**
 * UI verification via a real browser.
 *
 * Loads the frontend, walks the genesis → world → inspector flow, captures
 * screenshots and reports any console errors or unhandled exceptions.
 *
 *   node scripts/verify-ui.mjs [url] [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const url = process.argv[2] ?? 'http://127.0.0.1:1420/';
const outDir = process.argv[3] ?? '/tmp/eden-ui';
mkdirSync(outDir, { recursive: true });

/**
 * Find a usable Chromium.
 *
 * The globally installed Playwright expects a browser revision that may not be
 * cached locally, so fall back to whichever revision *is* present.
 */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const candidates = readdirSync(cache)
    .filter((name) => name.startsWith('chromium-'))
    .sort()
    .reverse();
  const relative = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const dir of candidates) {
    for (const sub of relative) {
      const candidate = join(cache, dir, sub);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const errors = [];
const logs = [];

const executablePath = findChromium();
if (executablePath) console.log(`using chromium at ${executablePath}`);
const browser = await chromium.launch({
  executablePath,
  args: [
    // Headless Chromium has no GPU; force the software rasteriser so WebGL is
    // available to PixiJS.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);

page.on('console', (message) => {
  const text = `${message.type()}: ${message.text()}`;
  logs.push(text);
  // Ignore the browser's automatic favicon probe; it is not an application error.
  if (message.type() === 'error' && !/favicon|Failed to load resource/.test(message.text())) {
    errors.push(text);
  }
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

async function shot(name) {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`  captured ${name}.png`);
}

console.log(`opening ${url}`);
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(1500);

/** Run a step, reporting failures instead of aborting the whole run. */
async function step(label, fn) {
  try {
    await fn();
  } catch (error) {
    console.log(`  !! ${label}: ${error.message.split('\n')[0]}`);
    errors.push(`${label}: ${error.message.split('\n')[0]}`);
  }
}

// --- 1. Genesis screen -----------------------------------------------------
const heading = await page.textContent('h1').catch(() => null);
console.log(`  heading: ${heading?.replace(/\s+/g, ' ').trim()}`);
await shot('01-genesis');

// --- 2. Genesis ------------------------------------------------------------
const seedInput = page.locator('#seed');
await seedInput.fill('eden');
console.log('  seed set to "eden"');
await shot('02-genesis-filled');

await page.getByRole('button', { name: /genesis/i }).click();
console.log('  clicked GENESIS');

// Give the worker time to build the world and the renderer to draw.
await page.waitForTimeout(5000);
await shot('03-world');

// Report what actually rendered.
const worldHtmlLength = await page.locator('.world').count();
const canvasCount = await page.locator('.viewport canvas').count();
const topbarText = await page.locator('.topbar').textContent().catch(() => null);
console.log(`  .world present: ${worldHtmlLength > 0}, canvases: ${canvasCount}`);
console.log(`  top bar: ${topbarText?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? 'ABSENT'}`);
const bodyText = await page.locator('body').innerText().catch(() => '');
console.log(`  body text (first 200 chars): ${JSON.stringify(bodyText.slice(0, 200))}`);
if (errors.length > 0) {
  console.log('  errors so far:');
  for (const error of errors.slice(0, 10)) console.log(`    ${error}`);
}

// --- 3. Let the simulation run at x20 -------------------------------------
await step('speed x20', async () => {
  await page.locator('.speed-group button', { hasText: '20' }).first().click();
});
await page.waitForTimeout(6000);
await shot('04-world-x20');

// --- 4. Select a human ------------------------------------------------------
// Prefer the dev-only handle so the run is deterministic; fall back to clicking.
const selected = await page
  .evaluate(() => {
    const client = window.__eden;
    if (!client) return null;
    const human = client.getSnapshot().entities.find((entity) => entity.kind === 0);
    if (!human) return null;
    client.select(human.id);
    return { id: human.id, name: human.id };
  })
  .catch(() => null);

if (selected) {
  console.log(`  selected human #${selected.id} via the dev handle`);
} else {
  const viewport = page.locator('.viewport');
  const box = await viewport.boundingBox();
  if (box) {
    for (const offset of [0, 40, -40, 80, -80, 120, -120, 20, -20, 160, -160]) {
      await page.mouse.click(box.x + box.width / 2 + offset, box.y + box.height / 2);
      await page.waitForTimeout(500);
      const name = await page.locator('.inspector .panel h3').first().textContent().catch(() => null);
      if (name && !/No human selected/.test(name)) {
        console.log(`  selected by clicking: ${name}`);
        break;
      }
    }
  }
}
await page.waitForTimeout(1500);
await shot('05-inspector');

// Scroll the inspector so the brain view and the trace are visible.
const inspector = page.locator('.inspector');
await inspector.evaluate((element) => {
  element.scrollTop = element.scrollHeight * 0.62;
});
await page.waitForTimeout(1500);
await shot('06-brain-and-trace');

await inspector.evaluate((element) => {
  element.scrollTop = element.scrollHeight;
});
await page.waitForTimeout(800);
await shot('07-why');

// --- 5. Developer panel ----------------------------------------------------
await page.keyboard.press('Meta+Shift+D');
await page.waitForTimeout(800);
const devVisible = await page.locator('.devpanel').isVisible().catch(() => false);
console.log(`  developer panel visible: ${devVisible}`);
await shot('08-dev-panel');

// --- 6. Pause and step -----------------------------------------------------
await page.keyboard.press('Space');
await page.waitForTimeout(400);
const paused = await page.locator('.speed-group button.active').first().textContent().catch(() => null);
console.log(`  after space, active speed button: ${paused}`);
await page.keyboard.press('Period');
await page.waitForTimeout(400);
await shot('09-paused');

// --- 7. Event feed and stats ----------------------------------------------
const eventCount = await page.locator('.event').count();
console.log(`  world events in the feed: ${eventCount}`);
const statStrip = await page.locator('.stat-strip').textContent().catch(() => '');
console.log(`  top bar: ${statStrip?.replace(/\s+/g, ' ').trim()}`);

// --- 8. God tool: lightning -----------------------------------------------
await page.getByRole('button', { name: /lightning/i }).click();
await page.waitForTimeout(300);
const viewportBox = await page.locator('.viewport').boundingBox();
if (viewportBox) {
  await page.mouse.click(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2 - 60);
}
await page.waitForTimeout(600);
await shot('10-lightning');

// --- 9. Family tree --------------------------------------------------------
await page.getByRole('button', { name: /family tree/i }).click();
await page.waitForTimeout(1500);
const treeVisible = await page.locator('.modal').isVisible().catch(() => false);
console.log(`  family tree modal visible: ${treeVisible}`);
await shot('11-genealogy');
await page.getByRole('button', { name: /close/i }).first().click();
await page.waitForTimeout(400);

// --- 10. Save / load -------------------------------------------------------
await page.getByRole('button', { name: /^save$/i }).click();
await page.waitForTimeout(1200);
await shot('12-saved');

console.log('\n--- console errors ---');
if (errors.length === 0) console.log('  none');
else for (const error of errors.slice(0, 20)) console.log(`  ${error}`);

console.log('\n--- last 12 console messages ---');
for (const log of logs.slice(-12)) console.log(`  ${log}`);

await browser.close();
console.log(`\nscreenshots in ${outDir}`);
process.exitCode = errors.length > 0 ? 1 : 0;
