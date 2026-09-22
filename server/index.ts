/**
 * EDEN//0 shared-observation server.
 *
 * ONE AUTHORITATIVE WORLD, MANY OBSERVERS
 * ---------------------------------------
 * The world lives here, on the server, and every connected observer receives the
 * same snapshots. That is a different architecture from the local single-player
 * mode, where the world lives in a Web Worker inside the browser, and the two
 * coexist: the client picks a transport at startup and everything above it is
 * unchanged.
 *
 * The simulation itself is the same TypeScript either way — `World` has no DOM
 * dependency and already runs headless in `scripts/simulate.ts`, which is what
 * made this possible without forking the codebase.
 *
 * WHAT IS AND IS NOT AUTHORITATIVE
 * --------------------------------
 * The server owns time and state. Clients send god commands and receive an ack;
 * they never mutate the world locally. There is no client-side prediction of
 * *simulation* state, because an observer does not control anything that needs
 * predicting — what the client does instead is interpolate between the last two
 * snapshots so motion looks smooth at 60 fps while snapshots arrive at 20 Hz.
 * God commands get optimistic local feedback (the click lands instantly) and are
 * reconciled against the next authoritative snapshot.
 *
 * Usage:
 *   npm run server              # serves ./dist and hosts a world
 *   npm run server -- --port 8080 --speed 4 --seed eden
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { World, DEFAULT_WORLD_OPTIONS } from '../src/simulation/world';
import { applyGodCommand } from '../src/simulation/commands';
import { acceptUpgrade, WebSocketConnection } from './ws';
import { encodeFrame, WireType } from '../src/shared/wire';
import { SNAPSHOT_FLOAT_STRIDE, SNAPSHOT_META_STRIDE } from '../src/shared/types';
import { SNAPSHOT_HZ_NORMAL, SIM_HZ } from '../src/shared/constants';
import type { GodCommand } from '../src/shared/protocol';

const argv = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const PORT = Number(arg('port', '8080'));
const HOST = arg('host', '127.0.0.1');
const SPEED = Number(arg('speed', '4'));
const SEED = arg('seed', 'eden');
const HUMANS = Number(arg('humans', '8'));
const PREDATORS = Number(arg('predators', '2'));
const DIST = resolve(process.cwd(), 'dist');

// --- the world --------------------------------------------------------------

const world = new World({
  ...DEFAULT_WORLD_OPTIONS,
  seed: SEED,
  initialHumans: HUMANS,
  initialPredators: PREDATORS,
});

let revision = 0;
let running = true;

const observers = new Set<WebSocketConnection>();

// --- snapshot broadcasting --------------------------------------------------

/**
 * Split a snapshot into its JSON header and its binary payload.
 *
 * The three typed arrays are the same on every frame and are the part that costs
 * bandwidth; everything else changes shape and stays JSON. See shared/wire.ts.
 */
function packSnapshot(): { header: Record<string, unknown>; arrays: Uint8Array[] } {
  const snapshot = world.buildSnapshot(revision++, {
    tps: 0,
    fps: 0,
    tickTimeMs: 0,
    brainTimeMs: 0,
    snapshotBytes: 0,
    workerLatencyMs: 0,
    synapseCount: 0,
    entityCount: entityTotal(),
    humanCount: world.humans.length,
    predatorCount: world.predators.length,
    plantCount: world.plants.length,
  });

  const { ids, floats, meta, ...rest } = snapshot;
  return {
    // The strides go in the header so the client can slice the payload without
    // duplicating the constants — one place to change if the layout ever moves.
    header: { ...rest, floatStride: SNAPSHOT_FLOAT_STRIDE, metaStride: SNAPSHOT_META_STRIDE } as unknown as Record<
      string,
      unknown
    >,
    arrays: [
      new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength),
      new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength),
      new Uint8Array(meta.buffer, meta.byteOffset, meta.byteLength),
    ],
  };
}

function entityTotal(): number {
  let count = 0;
  for (const human of world.humans) if (human.alive) count++;
  return count + world.predators.length + world.plants.length;
}

function broadcast(): void {
  if (observers.size === 0) return;
  const { header, arrays } = packSnapshot();
  const frame = encodeFrame(WireType.Snapshot, header, arrays);
  for (const observer of observers) observer.send(frame, true);
}

// --- connection handling ----------------------------------------------------

function onConnection(connection: WebSocketConnection): void {
  observers.add(connection);
  const slot = observers.size;
  connection.context = { slot, commandsAccepted: 0 };

  connection.on('message', (message) => {
    if (message.binary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data.toString('utf8'));
    } catch {
      connection.send(encodeFrame(WireType.Error, { message: 'malformed JSON' }), true);
      return;
    }
    const envelope = parsed as { type?: string; command?: GodCommand };
    if (envelope.type === 'command' && envelope.command) {
      handleCommand(connection, envelope.command);
    } else if (envelope.type === 'ping') {
      connection.send(encodeFrame(WireType.Ack, { pong: Date.now() }), true);
    }
  });

  connection.on('close', () => {
    observers.delete(connection);
  });

  // Welcome, then an immediate snapshot so a late joiner sees the world at once
  // rather than waiting for the next broadcast tick.
  connection.send(
    encodeFrame(WireType.Welcome, {
      seed: SEED,
      speed: SPEED,
      simHz: SIM_HZ,
      snapshotHz: SNAPSHOT_HZ_NORMAL,
      tick: world.tick,
      slot,
      observers: observers.size,
    }),
    true,
  );
  const { header, arrays } = packSnapshot();
  connection.send(encodeFrame(WireType.Snapshot, header, arrays), true);
}

function handleCommand(connection: WebSocketConnection, command: GodCommand): void {
  let outcome: string;
  try {
    outcome = applyGodCommand(world, command);
  } catch (error) {
    outcome = `failed: ${(error as Error).message}`;
  }
  const context = connection.context as { commandsAccepted: number } | null;
  if (context) context.commandsAccepted += 1;

  // Everyone hears about it, so two observers watching the same world see each
  // other's interventions rather than silently disagreeing about what happened.
  const ack = encodeFrame(WireType.Ack, { command: command.kind, outcome, tick: world.tick });
  for (const observer of observers) observer.send(ack, true);
  broadcast();
}

// --- static files -----------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  // normalize + prefix check: without this, `/../../etc/passwd` escapes DIST.
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, relative);

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // Single-page app: unknown paths fall back to index.html.
    filePath = join(DIST, 'index.html');
  }

  if (!filePath.startsWith(DIST)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

// --- bootstrap --------------------------------------------------------------

const server = createServer((request, response) => {
  void serveStatic(request, response);
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/world') {
    socket.destroy();
    return;
  }
  const connection = acceptUpgrade(request, socket);
  if (!connection) return;
  // `head` holds bytes that arrived in the same packet as the handshake; feed
  // them in or the first frame is silently lost.
  if (head && head.length > 0) socket.unshift(head);
  onConnection(connection);
});

// Fixed-timestep loop. The world advances in whole ticks of DT; `SPEED` changes
// how many ticks happen per real second, never the size of a tick. That is the
// same rule the local worker follows, and it is what keeps a server world and a
// browser world numerically identical for the same seed.
const ticksPerSecond = SIM_HZ * SPEED;
const intervalMs = 1000 / Math.max(1, Math.min(SIM_HZ, ticksPerSecond));
const ticksPerInterval = Math.max(1, Math.round(ticksPerSecond / (1000 / intervalMs)));
const broadcastEvery = Math.max(1, Math.round((1000 / SNAPSHOT_HZ_NORMAL) / intervalMs));

let intervalCount = 0;
const loop = setInterval(() => {
  if (!running) return;
  for (let i = 0; i < ticksPerInterval; i++) world.step();
  intervalCount += 1;
  if (intervalCount % broadcastEvery === 0) broadcast();
}, intervalMs);

server.listen(PORT, HOST, () => {
  console.log(`EDEN//0 server`);
  console.log(`  world      seed "${SEED}", ${HUMANS} humans, ${PREDATORS} predators`);
  console.log(`  tick       ${SIM_HZ} Hz x${SPEED} = ${ticksPerSecond} ticks/s`);
  console.log(`  observers  ws://${HOST}:${PORT}/world`);
  console.log(`  client     http://${HOST}:${PORT}/`);
  console.log(`  static     ${DIST}`);
});

function shutdown(): void {
  running = false;
  clearInterval(loop);
  for (const observer of observers) observer.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(0), 500);
  forceExit.unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
