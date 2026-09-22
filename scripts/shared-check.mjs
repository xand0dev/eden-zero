import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function findChromium() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const candidates = readdirSync(cache)
    .filter((n) => n.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const dir of candidates) {
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

const errors = [];
const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(15000);
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
});

console.log('opening the server-hosted world at http://127.0.0.1:8080/?server=auto&debug=1');
await page.goto('http://127.0.0.1:8080/?server=auto&debug=1', { waitUntil: 'load' });
await page.waitForTimeout(6000);

const read = () =>
  page.evaluate(() => {
    const c = window.__eden;
    if (!c) return null;
    const s = c.getSnapshot();
    return {
      phase: s.phase,
      tick: s.tick,
      pop: s.stats ? s.stats.population : 0,
      huts: s.stats ? s.stats.huts : 0,
      entities: s.entities.length,
      remote: c.isRemote,
      status: c.remoteStatus,
      seed: c.remoteInfo ? c.remoteInfo.seed : null,
      observers: c.remoteInfo ? c.remoteInfo.observers : null,
    };
  });

const first = await read();
console.log('  after connect: ' + JSON.stringify(first));

await page.waitForTimeout(4000);
const second = await read();
console.log('  four seconds later: ' + JSON.stringify(second));

if (first && second) {
  console.log('  tick advanced by ' + (second.tick - first.tick));
  console.log('  world came from the server: ' + String(second.remote));
  console.log('  seed reported by server: ' + String(second.seed));
}

await page.screenshot({ path: '/tmp/eden-ui/20-shared-world.png' });
console.log('\nconsole errors:');
console.log(errors.length ? errors.slice(0, 8).join('\n') : '  none');
await browser.close();
