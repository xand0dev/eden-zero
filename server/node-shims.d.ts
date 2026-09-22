/**
 * Minimal ambient declarations for the Node APIs the server touches.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The project has no `@types/node` (the frontend is a browser app and does not
 * need it), and the sandbox has no network access to install it. Rather than
 * leave the server untypechecked — which is how a wire-format bug reaches
 * production — the exact surface the server uses is declared here.
 *
 * This is deliberately a *shim*, not a reimplementation of the Node type
 * definitions: it declares only what `server/` actually calls. If the server
 * starts using a new Node API, `tsc` will fail here, which is the correct
 * behaviour — the addition gets made consciously rather than silently.
 */

declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'base64' | 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:stream' {
  export interface Duplex {
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'error' | 'close', listener: () => void): this;
    write(data: string | Uint8Array): boolean;
    end(data?: Uint8Array): void;
    destroy(): void;
    unshift(data: Uint8Array): void;
    setTimeout(milliseconds: number, callback?: () => void): this;
    setNoDelay(noDelay?: boolean): this;
  }
}

declare module 'node:http' {
  import type { Duplex } from 'node:stream';

  export interface IncomingMessage {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
  }

  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string | number>): ServerResponse;
    end(body?: string | Uint8Array): void;
  }

  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    close(callback?: () => void): void;
    on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Uint8Array) => void): void;
  }

  export function createServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare module 'node:fs/promises' {
  export interface Stats {
    isDirectory(): boolean;
    size: number;
  }
  export function readFile(path: string): Promise<Buffer>;
  export function stat(path: string): Promise<Stats>;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function normalize(path: string): string;
  export function resolve(...parts: string[]): string;
  export function extname(path: string): string;
}

declare const process: {
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  env: Record<string, string | undefined>;
};

interface BufferConstructor {
  new (input: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
  alloc(size: number, fill?: number): Buffer;
  from(data: string, encoding?: string): Buffer;
  from(data: Uint8Array | ArrayBufferLike | number[]): Buffer;
  concat(parts: Uint8Array[]): Buffer;
  byteLength(data: string, encoding?: string): number;
}
declare const Buffer: BufferConstructor;

interface Buffer extends Uint8Array<ArrayBuffer> {
  subarray(begin?: number, end?: number): Buffer;
  slice(begin?: number, end?: number): Buffer;
  readUInt16BE(offset: number): number;
  readUInt32BE(offset: number): number;
  writeUInt16BE(value: number, offset: number): void;
  writeUInt32BE(value: number, offset: number): void;
  write(data: string, offset: number, encoding?: string): number;
  toString(encoding?: string): string;
  length: number;
}

interface TimerHandle {
  unref(): void;
}
declare function setInterval(callback: () => void, milliseconds: number): TimerHandle;
declare function clearInterval(handle: TimerHandle): void;
declare function setTimeout(callback: () => void, milliseconds: number): TimerHandle;
declare function clearTimeout(handle: TimerHandle): void;
