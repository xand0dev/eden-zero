/**
 * Wire format for the shared-observation protocol.
 *
 * Shared verbatim between the Node server and the browser client, so a change
 * here is a change on both sides at once and cannot drift.
 *
 * FRAME LAYOUT
 * ------------
 *   offset  size  field
 *   0       4     magic 0x45 0x44 0x4E 0x30  ("EDN0")
 *   4       1     frame type (see WireType)
 *   5       4     header length, uint32 big-endian
 *   9       H     header, UTF-8 JSON
 *   9+H     ...   payload: concatenated typed-array buffers, in the order the
 *                 header describes
 *
 * WHY A JSON HEADER AND A BINARY BODY
 * -----------------------------------
 * The header changes shape between frame types and is tiny (a few hundred
 * bytes), so JSON keeps it readable and debuggable. The entity data is the same
 * three typed arrays every single frame and is the part that actually costs
 * bandwidth, so it stays raw. This is the ordinary split in game netcode.
 *
 * WHY BIG-ENDIAN
 * --------------
 * Network byte order. Every multi-byte integer on the wire is big-endian, which
 * is what `DataView` defaults to and what every other protocol does. Mixing
 * endianness across a wire format is a classic and miserable bug.
 */

export const WIRE_MAGIC = 0x45444e30;

export const WireType = {
  /** Server -> client: a full world snapshot. */
  Snapshot: 1,
  /** Server -> client: handshake, world config, and the observer's slot. */
  Welcome: 2,
  /** Client -> server: a god command. */
  Command: 3,
  /** Server -> client: the outcome of a command. */
  Ack: 4,
  /** Either direction: something went wrong. */
  Error: 5,
} as const;
export type WireType = (typeof WireType)[keyof typeof WireType];

export const HEADER_OFFSET = 9;

export interface DecodedFrame {
  type: number;
  header: Record<string, unknown>;
  /** Raw payload bytes after the header. */
  payload: Uint8Array;
}

function isBufferLike(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

/**
 * Encode one frame.
 *
 * `payload` may be a single view or a list of views; they are concatenated in
 * order and the header is expected to describe them in that same order.
 */
export function encodeFrame(
  type: number,
  header: Record<string, unknown>,
  payload: Uint8Array | ArrayBufferView | Array<ArrayBufferView> | null = null,
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const parts: Uint8Array[] = [];
  if (payload) {
    if (Array.isArray(payload)) {
      for (const part of payload) parts.push(toBytes(part));
    } else {
      parts.push(toBytes(payload));
    }
  }
  const payloadLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(HEADER_OFFSET + headerBytes.byteLength + payloadLength);
  const view = new DataView(out.buffer);

  view.setUint32(0, WIRE_MAGIC, false);
  view.setUint8(4, type);
  view.setUint32(5, headerBytes.byteLength, false);
  out.set(headerBytes, HEADER_OFFSET);

  let offset = HEADER_OFFSET + headerBytes.byteLength;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function toBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Decode a frame. Returns null if the buffer is not a valid frame. */
export function decodeFrame(buffer: Uint8Array): DecodedFrame | null {
  if (buffer.byteLength < HEADER_OFFSET) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, false) !== WIRE_MAGIC) return null;
  const type = view.getUint8(4);
  const headerLength = view.getUint32(5, false);
  if (buffer.byteLength < HEADER_OFFSET + headerLength) return null;

  const headerBytes = buffer.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLength);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
  } catch {
    return null;
  }

  return {
    type,
    header,
    payload: buffer.subarray(HEADER_OFFSET + headerLength),
  };
}

/**
 * Read a typed array out of a frame payload.
 *
 * The payload is one flat byte range; this slices a section of it and reinterprets
 * it as the requested type. `byteOffset` must be aligned to the element size,
 * which the encoder guarantees by writing the arrays in declaration order.
 */
export function viewOf(
  payload: Uint8Array,
  byteOffset: number,
  byteLength: number,
  kind: 'i32' | 'f32' | 'u8',
): Int32Array | Float32Array | Uint8Array {
  // Copy rather than alias: the receive buffer may be reused by the transport,
  // and a detached view is a very confusing bug to chase.
  const slice = payload.slice(byteOffset, byteOffset + byteLength);
  const buffer = slice.buffer;
  if (kind === 'i32') return new Int32Array(buffer);
  if (kind === 'f32') return new Float32Array(buffer);
  return new Uint8Array(buffer);
}

/** Round-trip check used by the tests. */
export function roundTrip(type: number, header: Record<string, unknown>, payload?: Uint8Array): DecodedFrame | null {
  const encoded = encodeFrame(type, header, payload ?? null);
  return decodeFrame(encoded);
}

export { isBufferLike };
