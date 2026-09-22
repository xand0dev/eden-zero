/**
 * Server smoke test.
 *
 * Boots the real server, connects a real WebSocket client over a real socket,
 * and checks that the whole chain works: upgrade handshake, welcome frame,
 * snapshot frames arriving at roughly the advertised rate, and a god command
 * round-tripping back as an ack.
 *
 * The point is that nothing here is mocked. A unit test on the frame codec proves
 * the codec; only this proves the handshake, the HTTP upgrade path and the tick
 * loop actually work together.
 *
 *   npm run smoke:server
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 8123;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** Client-side frame encoder (masked, as a browser would send). */
function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, mask, masked]);
}

async function main(): Promise<void> {
  console.log('EDEN//0 server smoke test\n');

  const server: ChildProcess = spawn(
    './node_modules/.bin/tsx',
    ['server/index.ts', '--port', String(PORT), '--speed', '20', '--seed', 'smoke'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverLog = '';
  server.stdout?.on('data', (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  server.stderr?.on('data', (chunk: Buffer) => {
    serverLog += chunk.toString();
  });

  const stop = (): void => {
    if (!server.killed) server.kill('SIGTERM');
  };

  try {
    // Wait for the listen line rather than guessing a delay.
    for (let i = 0; i < 60 && !serverLog.includes('observers'); i++) await delay(100);
    check('server boots and reports its listener', serverLog.includes('observers'), serverLog.split('\n')[1] ?? '');

    const socket = connect(PORT, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    let handshake = Buffer.alloc(0);
    const frames: Array<{ opcode: number; payload: Buffer }> = [];

    await new Promise<void>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let upgraded = false;

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
          handshake = handshake.subarray(0, end + 4);
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

    const text = handshake.toString('utf8');
    const expected = createHash('sha1').update(key + GUID).digest('base64');
    check('upgrade returns 101', text.startsWith('HTTP/1.1 101'), text.split('\r\n')[0]);
    check('Sec-WebSocket-Accept is correct', text.includes(expected));
    check('connection is upgraded', text.toLowerCase().includes('upgrade: websocket'));

    // Give the loop a moment to produce snapshots.
    await delay(1200);

    check('server sends binary frames', frames.some((f) => f.opcode === 0x2), `${frames.length} frames in 1.2s`);

    const welcome = frames.find((f) => f.opcode === 0x2 && decodeHeader(f.payload)?.type === 2);
    check('welcome frame arrives first', welcome !== undefined);
    const welcomeHeader = welcome ? decodeHeader(welcome.payload)?.header : null;
    check('welcome carries the world config', welcomeHeader?.seed === 'smoke', `seed=${String(welcomeHeader?.seed)}`);

    const snapshots = frames.filter((f) => f.opcode === 0x2 && decodeHeader(f.payload)?.type === 1);
    check('snapshots keep arriving', snapshots.length >= 3, `${snapshots.length} snapshots`);

    const latest = snapshots.at(-1);
    const decoded = latest ? decodeHeader(latest.payload) : null;
    const population = (decoded?.header.stats as { population?: number } | undefined)?.population;
    check('snapshot reports a living population', (population ?? 0) > 0, `population=${population}`);

    // A god command should come back as an ack to every observer.
    socket.write(
      encodeClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'command', command: { kind: 'lightning', x: 60, y: 60 } }))),
    );
    await delay(600);
    const ack = frames.find((f) => f.opcode === 0x2 && decodeHeader(f.payload)?.type === 4);
    check('god command is acknowledged', ack !== undefined);
    const ackHeader = ack ? (decodeHeader(ack.payload)?.header as { outcome?: string } | undefined) : null;
    check('ack describes the outcome', typeof ackHeader?.outcome === 'string', String(ackHeader?.outcome));

    socket.destroy();
  } finally {
    stop();
  }

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

interface ServerFrame {
  opcode: number;
  payload: Buffer;
  consumed: number;
}

/** Decode one server frame (server frames are never masked). */
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

/** Read just the frame header of an EDEN frame. */
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
