/**
 * Forest probe — is felling visible in the world?
 *
 * Runs the real UI at maximum speed for a while and reports how the forest is
 * changing, then screenshots it. The point is not to assert a number but to look
 * at the thing: a renderer that is wrong while every test passes is a mistake
 * this repository has already made once.
 *
 * Usage: node scripts/forest-probe.mjs [seconds]
 */
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
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(30000);

await page.goto('http://127.0.0.1:1420/?debug=1', { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.locator('#seed').fill('builders');
await page.getByRole('button', { name: /genesis/i }).click();
await page.waitForTimeout(3500);

// Maximum speed so the settlement has simulated hours to work with.
await page.evaluate(() => {
  window.__eden.setSpeed(-1);
});

const totalSeconds = Number(process.argv[2] ?? 45);
const readStats = () =>
  page.evaluate(() => {
    const snapshot = window.__eden.getSnapshot();
    const stats = snapshot.stats ?? {};
    return {
      tick: snapshot.tick,
      population: stats.population ?? 0,
      huts: stats.huts ?? 0,
      timber: stats.timber ?? 0,
      trees: stats.trees ?? 0,
      fields: (window.__eden.getSnapshot().fields ?? []).length,
      canals: (window.__eden.getSnapshot().canals ?? []).length,
    };
  });

const before = await readStats();
console.log('EDEN//0 forest probe');
console.log('');
console.log('  start     tick=' + before.tick + '  trees=' + before.trees + '  timber=' + before.timber.toFixed(0));

for (let elapsed = 5; elapsed <= totalSeconds; elapsed += 5) {
  await page.waitForTimeout(5000);
  const now = await readStats();
  console.log(
    '  t+' + String(elapsed).padStart(3) + 's   tick=' + String(now.tick).padStart(7) +
    '  pop=' + String(now.population).padStart(2) +
    '  huts=' + String(now.huts).padStart(2) +
    '  trees=' + String(now.trees).padStart(4) +
    '  timber=' + now.timber.toFixed(0).padStart(6) +
    '  fields=' + String(now.fields).padStart(2) +
    '  canals=' + String(now.canals).padStart(3),
  );
}

const after = await readStats();

// Daylight, so the forest is actually legible in the screenshot. The night
// overlay is dark enough that a stripped stand would be hard to judge.
await page.evaluate(() => {
  window.__eden.god({ kind: 'timeOfDay', phase: 0.42 });
});
await page.waitForTimeout(1200);

await page.screenshot({ path: '/tmp/eden-forest.png' });
console.log('');
console.log('  ticks simulated: ' + (after.tick - before.tick));
console.log('  huts built:      ' + (after.huts - before.huts));
console.log('  timber delta:    ' + (after.timber - before.timber).toFixed(0));
console.log('  screenshot:      /tmp/eden-forest.png');
console.log('');

await browser.close();
