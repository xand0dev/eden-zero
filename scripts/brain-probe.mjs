import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function findChromium() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  for (const dir of readdirSync(cache)
    .filter((n) => n.startsWith('chromium-'))
    .sort()
    .reverse()) {
    for (const sub of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ]) {
      const p = join(cache, dir, sub);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
page.setDefaultTimeout(30000);

await page.goto('http://127.0.0.1:1420/?debug=1', { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.locator('#seed').fill('brain');
await page.getByRole('button', { name: /genesis/i }).click();
await page.waitForTimeout(4000);

// Let a little time pass so there is something to see in the brain.
await page.evaluate(() => window.__eden.setSpeed(-1));
await page.waitForTimeout(6000);
await page.evaluate(() => window.__eden.setSpeed(1));

// Open an adult human's brain.
const info = await page.evaluate(() => {
  const snapshot = window.__eden.getSnapshot();
  const keys = Object.keys(snapshot);
  const entities = snapshot.entities ?? [];
  const stats = snapshot.stats ?? {};
  const human = entities.find((e) => e && e.kind === 'human') ?? entities[0];
  if (human) window.__eden.select(human.id);
  return {
    entityCount: entities.length,
    id: human ? human.id : -1,
    kind: human ? human.kind : 'none',
    population: stats.population,
    tick: snapshot.tick,
  };
});
console.log('entities=' + info.entityCount + ' selected ' + info.kind + ' #' + info.id + '  pop=' + info.population + ' tick=' + info.tick);

await page.waitForTimeout(2500);

// What does the brain panel actually think it is drawing?
const brainInfo = await page.evaluate(() => {
  const snapshot = window.__eden.getSnapshot();
  const brain = snapshot.brain;
  if (!brain) return { present: false };
  return {
    present: true,
    neuronCount: brain.neuronCount,
    motorCount: (brain.motor ?? []).length,
    activity: (brain.activity ?? []).length,
    synapses: (brain.synapses ?? []).length,
  };
});
console.log('brain panel sees: ' + JSON.stringify(brainInfo));

// Expand the brain to fill the window.
const expanded = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const button = buttons.find((b) => b.textContent.trim() === 'expand');
  if (!button) return false;
  button.click();
  return true;
});
console.log('expand button clicked: ' + expanded);
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/eden-brain-expanded.png' });
console.log('screenshot: /tmp/eden-brain-expanded.png');

await browser.close();
