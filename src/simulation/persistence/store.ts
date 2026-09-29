/**
 * World storage in IndexedDB, gzip-compressed.
 *
 * `localStorage` holds about five megabytes and a grown world is larger than
 * that: a sixty-person save used to be ten megabytes, and autosave silently
 * stopped working once a world got interesting. IndexedDB has no such ceiling
 * in practice, and compressing the envelope on top of the packed brains brings
 * a save down to a fraction of its old size.
 *
 * Everything degrades gracefully: without IndexedDB (a private window, an old
 * webview) saves fall back to `localStorage`, and without CompressionStream
 * they are stored as plain text.
 */

const DB_NAME = 'eden0';
const STORE = 'worlds';

export interface StoredWorldMeta {
  key: string;
  seed: string;
  tick: number;
  savedAt: string;
  bytes: number;
  mode?: string;
  era?: number;
  population?: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function gzip(text: string): Promise<Blob> {
  const blob = new Blob([text], { type: 'application/json' });
  if (typeof CompressionStream === 'undefined') return blob;
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function gunzip(blob: Blob, compressed: boolean): Promise<string> {
  if (!compressed || typeof DecompressionStream === 'undefined') return blob.text();
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

interface Record {
  meta: StoredWorldMeta;
  data: Blob;
  compressed: boolean;
}

export async function putWorld(key: string, text: string, meta: Omit<StoredWorldMeta, 'key' | 'bytes'>): Promise<boolean> {
  const db = await openDb();
  if (!db) {
    try {
      window.localStorage.setItem(`eden0.world.${key}`, text);
      return true;
    } catch {
      return false;
    }
  }
  const compressed = typeof CompressionStream !== 'undefined';
  const data = await gzip(text);
  const record: Record = { meta: { ...meta, key, bytes: data.size }, data, compressed };
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function getWorld(key: string): Promise<string | null> {
  const db = await openDb();
  if (!db) {
    try {
      return window.localStorage.getItem(`eden0.world.${key}`);
    } catch {
      return null;
    }
  }
  const record = await new Promise<Record | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve((request.result as Record | undefined) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  if (!record) return null;
  return gunzip(record.data, record.compressed);
}

export async function listWorlds(): Promise<StoredWorldMeta[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () =>
        resolve(((request.result as Record[]) ?? []).map((r) => r.meta).sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function deleteWorld(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
