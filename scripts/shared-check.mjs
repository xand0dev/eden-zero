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
page.setDefaultTimeout(20000);
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
});

console.log('opening the server-hosted world');
await page.goto('http://127.0.0.1:8080/?server=auto&debug=1', { waitUntil: 'load' });
await page.waitForTimeout(7000);

const read = () =>
  page.evaluate(() => {
    const c = window.__eden;
    const s = c.getSnapshot();
    return {
      tick: s.tick,
      pop: s.stats ? s.stats.population : 0,
      huts: s.stats ? s.stats.huts : 0,
      entities: s.entities.length,
      remote: c.isRemote,
      status: c.remoteStatus,
      seed: c.remoteInfo ? c.remoteInfo.seed : null,
    };
  });

const first = await read();
console.log('  after connect: ' + JSON.stringify(first));
await page.waitForTimeout(4000);
const second = await read();
console.log('  four seconds later: ' + JSON.stringify(second));
console.log('  tick advanced by ' + (second.tick - first.tick));

console.log('\nmeasuring rendered motion');
const motion = await page.evaluate(async () => {
  const renderer = window.__edenRenderer;
  if (!renderer) return { error: 'renderer handle missing' };

  // Sample every sprite on every animation frame. Picking one entity up front is
  // a trap: the first sprite in the map is often one that happens to be resting,
  // and a stationary entity looks identical whether motion is interpolated or
  // snapped.
  const track = new Map();
  const start = performance.now();
  let frames = 0;
  let snapshots = 0;
  let lastTick = -1;

  await new Promise((resolve) => {
    const step = () => {
      frames += 1;
      const tick = window.__eden.getSnapshot().tick;
      if (tick !== lastTick) {
        snapshots += 1;
        lastTick = tick;
      }
      for (const p of renderer.debugEntityPositions()) {
        let list = track.get(p.id);
        if (!list) {
          list = [];
          track.set(p.id, list);
        }
        list.push({ x: p.x, y: p.y });
      }
      if (performance.now() - start < 2000) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });

  // Score each entity by total path length and measure the one that actually
  // walked the furthest during the window.
  let best = null;
  let bestDistance = 0;
  for (const [id, list] of track) {
    if (list.length < 20) continue;
    let distance = 0;
    for (let i = 1; i < list.length; i++) {
      distance += Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y);
    }
    if (distance > bestDistance) {
      bestDistance = distance;
      best = list;
    }
  }
  if (!best) return { error: 'no moving entity found in the sampling window' };

  const distinct = new Set(best.map((s) => s.x.toFixed(4) + ',' + s.y.toFixed(4))).size;
  return {
    frames,
    snapshots,
    samples: best.length,
    distinct,
    travelled: bestDistance,
    seconds: (performance.now() - start) / 1000,
  };
});

if (motion.error) {
  console.log('  FAIL ' + motion.error);
} else {
  console.log('  frames drawn:             ' + motion.frames);
  console.log('  snapshots in that window: ' + motion.snapshots);
  console.log('  distinct rendered poses:  ' + motion.distinct);
  console.log('  frames per snapshot:      ' + (motion.frames / Math.max(1, motion.snapshots)).toFixed(2));
  console.log('  entity travelled:         ' + motion.travelled.toFixed(3) + ' tiles');

  // The test: without interpolation the rendered position can only change when a
  // snapshot arrives, so `distinct` can never exceed `snapshots`. With it, the
  // position changes on most frames, so `distinct` approaches `frames`.
  const interpolating = motion.distinct > motion.snapshots * 1.2;
  console.log(
    '  verdict: ' +
      (interpolating
        ? 'INTERPOLATED — ' + motion.distinct + ' poses from ' + motion.snapshots + ' snapshots'
        : 'SNAPPED — motion is quantised to the snapshot rate'),
  );
  if (!interpolating) process.exitCode = 1;
}

await page.screenshot({ path: '/tmp/eden-ui/20-shared-world.png' });
console.log('\nconsole errors:');
console.log(errors.length ? errors.slice(0, 8).join('\n') : '  none');
await browser.close();
