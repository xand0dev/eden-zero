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
// Reproduce a Retina display: this is where the seam appears.
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(20000);

await page.goto('http://127.0.0.1:1420/?debug=1', { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.locator('#seed').fill('overlay');
await page.getByRole('button', { name: /genesis/i }).click();
await page.waitForTimeout(3500);

// Night, so the overlay is actually drawn.
await page.evaluate(() => {
  window.__eden.god({ kind: 'timeOfDay', phase: 0 });
});
await page.waitForTimeout(1200);

const info = await page.evaluate(() => window.__edenRenderer.debugRendererInfo());
console.log('renderer sizing at night');
for (const [key, value] of Object.entries(info)) {
  console.log('  ' + key.padEnd(16) + ' ' + value);
}

const coverageW = (info.overlayWidth / info.screenWidth) * 100;
const coverageH = (info.overlayHeight / info.screenHeight) * 100;
console.log('');
console.log('  overlay covers width:  ' + coverageW.toFixed(1) + '% of the screen');
console.log('  overlay covers height: ' + coverageH.toFixed(1) + '% of the screen');

// The overlay must cover the whole viewport. At resolution 2 it used to cover
// exactly half, which drew a hard seam down the middle of the world.
const ok = coverageW > 99.5 && coverageH > 99.5;
console.log('  verdict: ' + (ok ? 'COVERS THE VIEWPORT' : 'MISALIGNED — the overlay is the wrong size'));
if (!ok) process.exitCode = 1;

await page.screenshot({ path: '/tmp/eden-ui/30-overlay.png' });
await browser.close();
