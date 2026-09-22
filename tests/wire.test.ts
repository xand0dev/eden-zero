import { describe, expect, it } from 'vitest';
import { decodeFrame as decodeWsFrame, encodeFrame as encodeWsFrame } from '../server/ws';
import { WIRE_MAGIC, WireType, decodeFrame, encodeFrame, viewOf } from '../src/shared/wire';

/**
 * These are the two formats everything else depends on: the WebSocket framing
 * (RFC 6455) and our own snapshot frame. A bug in either is invisible until it
 * corrupts data at runtime, so they get tested directly.
 */

describe('RFC 6455 frame codec', () => {
  it('round-trips a small unmasked frame', () => {
    const frame = encodeWsFrame(0x1, Buffer.from('hello'));
    const decoded = decodeWsFrame(frame)!;
    expect(decoded).not.toBeNull();
    expect(decoded.fin).toBe(true);
    expect(decoded.opcode).toBe(0x1);
    expect(decoded.payload.toString('utf8')).toBe('hello');
    expect(decoded.consumed).toBe(frame.length);
  });

  it('uses the 16-bit length path at 126 bytes and above', () => {
    const payload = Buffer.alloc(300, 0x41);
    const frame = encodeWsFrame(0x2, payload);
    // 2 header + 2 extended length + 300 payload
    expect(frame.length).toBe(304);
    const decoded = decodeWsFrame(frame)!;
    expect(decoded.payload.length).toBe(300);
  });

  it('uses the 64-bit length path above 65535 bytes', () => {
    const payload = Buffer.alloc(70000, 0x42);
    const frame = encodeWsFrame(0x2, payload);
    expect(frame[1]).toBe(127);
    const decoded = decodeWsFrame(frame)!;
    expect(decoded.payload.length).toBe(70000);
  });

  it('unmasks client frames, as RFC 6455 §5.3 requires', () => {
    // Build a masked client frame by hand: FIN|text, MASK|len, key, payload^key.
    const message = Buffer.from('masked payload');
    const key = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    const masked = Buffer.from(message);
    for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | message.length]),
      key,
      masked,
    ]);

    const decoded = decodeWsFrame(frame)!;
    expect(decoded.payload.toString('utf8')).toBe('masked payload');
  });

  it('returns null for a partial frame and decodes it once complete', () => {
    const frame = encodeWsFrame(0x2, Buffer.from([1, 2, 3, 4, 5]));
    expect(decodeWsFrame(frame.subarray(0, 3))).toBeNull();
    expect(decodeWsFrame(frame.subarray(0, 4))).toBeNull();
    const decoded = decodeWsFrame(frame)!;
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it('consumes exactly one frame when two are concatenated', () => {
    const first = encodeWsFrame(0x1, Buffer.from('one'));
    const second = encodeWsFrame(0x1, Buffer.from('two'));
    const joined = Buffer.concat([first, second]);

    const decoded = decodeWsFrame(joined)!;
    expect(decoded.payload.toString('utf8')).toBe('one');
    const rest = joined.subarray(decoded.consumed);
    expect(decodeWsFrame(rest)!.payload.toString('utf8')).toBe('two');
  });

  it('refuses a frame larger than the cap rather than allocating for it', () => {
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeUInt32BE(0xffffffff, 2);
    header.writeUInt32BE(0xffffffff, 6);
    expect(() => decodeWsFrame(header)).toThrow(/too large/);
  });
});

describe('snapshot wire format', () => {
  it('round-trips a header and typed-array payload', () => {
    const ids = new Int32Array([7, 8, 9]);
    const floats = new Float32Array([1.5, -2.25]);
    const meta = new Uint8Array([1, 2]);

    const encoded = encodeFrame(WireType.Snapshot, { tick: 42, count: 3 }, [ids, floats, meta]);
    const decoded = decodeFrame(encoded)!;

    expect(decoded.type).toBe(WireType.Snapshot);
    expect(decoded.header.tick).toBe(42);

    const outIds = viewOf(decoded.payload, 0, ids.byteLength, 'i32') as Int32Array;
    const outFloats = viewOf(decoded.payload, ids.byteLength, floats.byteLength, 'f32') as Float32Array;
    const outMeta = viewOf(decoded.payload, ids.byteLength + floats.byteLength, meta.byteLength, 'u8') as Uint8Array;

    expect(Array.from(outIds)).toEqual([7, 8, 9]);
    expect(outFloats[0]).toBeCloseTo(1.5, 5);
    expect(outFloats[1]).toBeCloseTo(-2.25, 5);
    expect(Array.from(outMeta)).toEqual([1, 2]);
  });

  it('writes the magic and type in the documented positions', () => {
    const encoded = encodeFrame(WireType.Welcome, { seed: 'eden' });
    const view = new DataView(encoded.buffer);
    expect(view.getUint32(0, false)).toBe(WIRE_MAGIC);
    expect(view.getUint8(4)).toBe(WireType.Welcome);
    expect(view.getUint32(5, false)).toBe(new TextEncoder().encode('{"seed":"eden"}').byteLength);
  });

  it('rejects a buffer with the wrong magic', () => {
    const encoded = encodeFrame(WireType.Snapshot, {});
    encoded[0] = 0x00;
    expect(decodeFrame(encoded)).toBeNull();
  });

  it('returns null rather than throwing on a truncated frame', () => {
    const encoded = encodeFrame(WireType.Snapshot, { tick: 1 }, new Uint8Array(64));
    expect(decodeFrame(encoded.subarray(0, 4))).toBeNull();
    expect(decodeFrame(encoded.subarray(0, 12))).toBeNull();
  });

  it('survives a non-ASCII header', () => {
    const encoded = encodeFrame(WireType.Ack, { outcome: 'засвітив блискавку ⚡' });
    const decoded = decodeFrame(encoded)!;
    expect(decoded.header.outcome).toBe('засвітив блискавку ⚡');
  });

  it('copies payload slices so a reused buffer cannot corrupt a view', () => {
    const encoded = encodeFrame(WireType.Snapshot, {}, new Uint8Array([9, 9, 9]));
    const decoded = decodeFrame(encoded)!;
    const view = viewOf(decoded.payload, 0, 3, 'u8') as Uint8Array;
    // Mutate the source; the view must not change.
    decoded.payload.fill(0);
    expect(Array.from(view)).toEqual([9, 9, 9]);
  });
});
