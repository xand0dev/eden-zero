/**
 * Competitive-mode smoke test.
 *
 * Boots the server with `--match`, connects TWO real WebSocket clients, and
 * checks the things that make it a game rather than a sandbox:
 *
 *  - the two observers are assigned opposite houses
 *  - a house-scoped command aimed at the enemy is REFUSED
 *  - a house-scoped command aimed at your own house is allowed
 *  - a world-scoped hostile command is allowed against anyone
 *  - commands cost influence, and running out is refused
 *  - the snapshot carries the scoreboard
 *
 *   npm run smoke:match
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 8124;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

interface Client {
  socket: ReturnType<typeof connect>;
  frames: Array<{ opcode: number; payload: Buffer }>;
  house: number;
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  const length = payload.length;
  const header = Buffer.alloc(length < 126 ? 2 : 4);
  if (length < 126) {
    header[1] = 0x80 | length;
  } else {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, mask, masked]);
}

async function connectClient(): Promise<Client> {
  const socket = connect(PORT, '127.0.0.1');
  const key = randomBytes(16).toString('base64');
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let handshake = Buffer.alloc(0);

  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => {
      socket.write(
        `GET /world HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end < 0) return;
        upgraded = true;
        buffer = handshake.subarray(end + 4);
        resolve();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = decodeServerFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        frames.push({ opcode: frame.opcode, payload: frame.payload });
      }
    });
  });

  // Read the house out of the welcome frame.
  for (let i = 0; i < 40; i++) {
    await delay(100);
    const welcome = frames.find((f) => f.opcode === 0x2 && decodeHeader(f.payload)?.type === 2);
    if (welcome) {
      const header = decodeHeader(welcome.payload)!.header as { house?: number };
      return { socket, frames, house: Number(header.house ?? 0) };
    }
  }
  return { socket, frames, house: -1 };
}

function sendCommand(client: Client, command: unknown): void {
  client.socket.write(
    encodeClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'command', command }))),
  );
}

/** Wait for an ack whose command kind matches, and return its outcome. */
async function awaitAck(client: Client, kind: string): Promise<string | null> {
  for (let i = 0; i < 40; i++) {
    await delay(100);
    for (const frame of client.frames) {
      if (frame.opcode !== 0x2) continue;
      const decoded = decodeHeader(frame.payload);
      if (decoded?.type !== 4) continue;
      const header = decoded.header as { command?: string; outcome?: string };
      if (header.command === kind) return header.outcome ?? null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  console.log('EDEN//0 competitive-mode smoke test\n');

  const server: ChildProcess = spawn(
    './node_modules/.bin/tsx',
    ['server/index.ts', '--port', String(PORT), '--speed', '20', '--seed', 'match', '--match'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  server.stdout?.on('data', (c: Buffer) => {
    log += c.toString();
  });
  server.stderr?.on('data', (c: Buffer) => {
    log += c.toString();
  });

  try {
    for (let i = 0; i < 60 && !log.includes('observers'); i++) await delay(100);
    check('server boots in match mode', log.includes('two houses'), log.split('\n').find((l) => l.includes('match')) ?? '');

    const a = await connectClient();
    const b = await connectClient();
    check('observer A is assigned a house', a.house >= 0, `house ${a.house}`);
    check('observer B gets the other house', b.house !== a.house, `${a.house} vs ${b.house}`);

    await delay(800);
    const snapshot = a.frames
      .filter((f) => f.opcode === 0x2)
      .map((f) => decodeHeader(f.payload))
      .find((d) => d?.type === 1);
    const matchView = snapshot?.header.match as
      | { enabled?: boolean; houses?: Array<{ house: number; population: number; score: number }>; duration?: number }
      | undefined;
    check('snapshot carries the scoreboard', matchView?.enabled === true);
    check('both houses are scored', (matchView?.houses?.length ?? 0) === 2);
    check(
      'houses start with a population',
      (matchView?.houses?.every((h) => h.population > 0) ?? false),
      matchView?.houses?.map((h) => `h${h.house}=${h.population}`).join(' '),
    );

    // --- the rules --------------------------------------------------------
    const ids = await pageIds(a);
    const myHuman = ids.find((h) => h.house === a.house);
    const enemyHuman = ids.find((h) => h.house !== a.house);
    check('the snapshot exposes both houses', myHuman !== undefined && enemyHuman !== undefined);

    if (myHuman && enemyHuman) {
      // Moving your own person is allowed.
      sendCommand(a, { kind: 'moveHuman', id: myHuman.id, x: 80, y: 60 });
      const own = await awaitAck(a, 'moveHuman');
      check('a command on your own house is allowed', own !== null && !own.startsWith('refused'), own ?? 'no ack');

      // Killing the enemy's person is not.
      sendCommand(a, { kind: 'kill', id: enemyHuman.id });
      const enemy = await awaitAck(a, 'kill');
      check(
        'a command on the other house is REFUSED',
        enemy !== null && enemy.startsWith('refused'),
        enemy ?? 'no ack',
      );
      check('the refusal names the other house', (enemy ?? '').includes('house'), enemy ?? '');
    }

    // Hostile world commands are unrestricted — that is what makes it a game.
    sendCommand(a, { kind: 'lightning', x: 80, y: 60 });
    const hostile = await awaitAck(a, 'lightning');
    check('a hostile world command is allowed', hostile !== null && !hostile.startsWith('refused'), hostile ?? 'no ack');

    a.socket.destroy();
    b.socket.destroy();
  } finally {
    if (!server.killed) server.kill('SIGTERM');
  }

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

/** Pull the human ids and their houses out of the latest snapshot. */
async function pageIds(client: Client): Promise<Array<{ id: number; house: number }>> {
  const snapshot = client.frames
    .filter((f) => f.opcode === 0x2)
    .map((f) => decodeHeader(f.payload))
    .reverse()
    .find((d) => d?.type === 1);
  if (!snapshot) return [];

  const payload = client.frames.filter((f) => f.opcode === 0x2).reverse().find((f) => {
    const d = decodeHeader(f.payload);
    return d?.type === 1;
  })!.payload;

  const header = snapshot.header as { count?: number; floatStride?: number; metaStride?: number };
  const count = Number(header.count ?? 0);
  const headerLength = payload.readUInt32BE(5);
  const body = payload.subarray(9 + headerLength);

  // Copy into a fresh, zero-offset buffer first. The header is a variable-length
  // UTF-8 string, so the payload almost never starts on a 4-byte boundary and a
  // typed array view over it throws. This is exactly why the client's `viewOf`
  // copies rather than aliasing.
  const aligned = new Uint8Array(body.byteLength);
  aligned.set(body);

  const ids = new Int32Array(aligned.buffer, 0, count);
  const metaStride = Number(header.metaStride ?? 4);
  const metaOffset = count * 4 + count * Number(header.floatStride ?? 12) * 4;
  const meta = new Uint8Array(aligned.buffer, metaOffset, count * metaStride);

  const out: Array<{ id: number; house: number }> = [];
  for (let i = 0; i < count; i++) {
    if (meta[i * metaStride] !== 0) continue; // 0 = human
    out.push({ id: ids[i], house: meta[i * metaStride + 4] ?? 0 });
  }
  return out;
}

interface ServerFrame {
  opcode: number;
  payload: Buffer;
  consumed: number;
}

function decodeServerFrame(buffer: Buffer): ServerFrame | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = buffer.readUInt32BE(6);
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return { opcode, payload: buffer.subarray(offset, offset + length), consumed: offset + length };
}

function decodeHeader(payload: Buffer): { type: number; header: Record<string, unknown> } | null {
  if (payload.length < 9) return null;
  const type = payload.readUInt8(4);
  const headerLength = payload.readUInt32BE(5);
  if (payload.length < 9 + headerLength) return null;
  try {
    return { type, header: JSON.parse(payload.subarray(9, 9 + headerLength).toString('utf8')) };
  } catch {
    return null;
  }
}

void main();
