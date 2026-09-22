/**
 * Minimal RFC 6455 WebSocket server implementation.
 *
 * WHY HAND-ROLLED
 * ---------------
 * `ws` is 40 lines of `npm install` and one more thing to explain. This program
 * asks the student to be able to modify any line live, so the wire format is
 * implemented here in full: the upgrade handshake, frame parsing with masking,
 * fragmentation, control frames and close semantics. It is about 200 lines and
 * has no dependencies.
 *
 * What this deliberately does NOT do (and why):
 *  - No permessage-deflate. Compression on a 20 Hz binary snapshot stream costs
 *    more CPU than it saves bandwidth, and our frames are already packed.
 *  - No TLS. That is a reverse proxy's job; the server speaks plain ws:// and the
 *    deployment puts it behind something that terminates TLS.
 *  - No extensions of any kind. We negotiate none and ignore any offered.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/** The constant from RFC 6455 §1.3. Yes, it is really this string. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Refuse absurd frames rather than allocating for them. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Refuse a connection whose first frame never arrives. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface WebSocketMessage {
  data: Buffer;
  binary: boolean;
}

export class WebSocketConnection {
  readonly socket: Duplex;
  /** Set once the close handshake has started, in either direction. */
  closed = false;
  /** Arbitrary per-connection state, used by the caller to hold a player slot. */
  context: unknown = null;

  private buffer: Buffer = Buffer.alloc(0);
  /** Accumulated fragments of a message that arrived split across frames. */
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private readonly listeners = {
    message: [] as Array<(message: WebSocketMessage) => void>,
    close: [] as Array<() => void>,
  };

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.ingest(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.finish());
  }

  on(event: 'message' | 'close', handler: ((message: WebSocketMessage) => void) | (() => void)): void {
    if (event === 'message') this.listeners.message.push(handler as (m: WebSocketMessage) => void);
    else this.listeners.close.push(handler as () => void);
  }

  /**
   * Send one message.
   *
   * Accepts a plain `Uint8Array` as well as a `Buffer` so callers can hand over
   * whatever the shared wire codec produced without a cast at every call site.
   */
  send(data: string | Uint8Array, binary = false): void {
    if (this.closed) return;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    this.socket.write(encodeFrame(binary ? OP_BINARY : OP_TEXT, payload));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.socket.write(encodeFrame(OP_CLOSE, payload));
    this.socket.end();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.finish();
  }

  private finish(): void {
    this.closed = true;
    for (const handler of this.listeners.close) handler();
    this.listeners.close.length = 0;
    this.listeners.message.length = 0;
  }

  private ingest(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // A single TCP read can carry several frames, or half of one. Loop until we
    // run out of complete frames and keep the remainder for the next read.
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.consumed);
      this.handleFrame(frame);
      if (this.closed) return;
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    switch (frame.opcode) {
      case OP_PING:
        this.socket.write(encodeFrame(OP_PONG, frame.payload));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        this.closed = true;
        this.socket.end(encodeFrame(OP_CLOSE, frame.payload));
        this.finish();
        return;
      case OP_TEXT:
      case OP_BINARY:
        if (frame.fin) {
          this.deliver(frame.payload, frame.opcode === OP_BINARY);
        } else {
          this.fragmentOpcode = frame.opcode;
          this.fragments = [frame.payload];
        }
        return;
      case OP_CONTINUATION: {
        if (this.fragments.length === 0) return;
        this.fragments.push(frame.payload);
        if (!frame.fin) return;
        const joined = Buffer.concat(this.fragments);
        const binary = this.fragmentOpcode === OP_BINARY;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.deliver(joined, binary);
        return;
      }
      default:
        this.destroy();
    }
  }

  private deliver(data: Buffer, binary: boolean): void {
    for (const handler of this.listeners.message) handler({ data, binary });
  }
}

interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  /** Bytes consumed from the input buffer, header included. */
  consumed: number;
}

/**
 * Try to decode one frame from the head of `buffer`.
 * Returns null when the buffer does not yet hold a complete frame.
 */
export function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const byte0 = buffer[0];
  const byte1 = buffer[1];
  const fin = (byte0 & 0x80) !== 0;
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let length = byte1 & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    // Above 2^32 we cannot represent it anyway, and it is certainly an attack.
    if (high !== 0) throw new Error('frame too large');
    length = low;
    offset += 8;
  }

  if (length > MAX_FRAME_BYTES) throw new Error('frame too large');

  let maskKey: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  // RFC 6455 §5.3: client-to-server frames MUST be masked. Unmask in place.
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
  }

  return { fin, opcode, payload, consumed: offset + length };
}

/** Build a server-to-client frame. Server frames are never masked. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/**
 * Complete the HTTP upgrade handshake.
 * Returns null and writes an error response if the request is not a valid
 * WebSocket upgrade.
 */
export function acceptUpgrade(request: IncomingMessage, socket: Duplex): WebSocketConnection | null {
  const key = request.headers['sec-websocket-key'];
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
  const version = request.headers['sec-websocket-version'];

  if (upgrade !== 'websocket' || typeof key !== 'string' || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }

  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setTimeout(0);
  socket.setNoDelay(true);

  const connection = new WebSocketConnection(socket);
  const guard = setTimeout(() => {
    if (!connection.closed && connection.context === null) connection.destroy();
  }, HANDSHAKE_TIMEOUT_MS);
  guard.unref?.();
  connection.on('close', () => clearTimeout(guard));
  return connection;
}
