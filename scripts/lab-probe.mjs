/**
 * Screenshot the sprite lab.
 *
 * Usage: node scripts/lab-probe.mjs
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
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
page.setDefaultTimeout(30000);

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto('http://127.0.0.1:1420/?lab=1', { waitUntil: 'load' });
await page.waitForTimeout(3500);

await page.screenshot({ path: '/tmp/eden-lab.png' });
console.log('screenshot: /tmp/eden-lab.png');
console.log('page errors: ' + (errors.length ? errors.slice(0, 4).join(' | ') : 'none'));

await browser.close();
