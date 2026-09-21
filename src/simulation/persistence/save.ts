/**
 * Save format + local persistence.
 *
 * A save is a versioned envelope around the world's serialised state:
 *
 *   { "format": "eden0-save", "version": 1, ... , "payload": { ... } }
 *
 * The envelope exists so that a future schema change can be detected and
 * migrated instead of silently producing a broken world.
 *
 * Storage strategy:
 *  - Autosave and the manual slot live in `localStorage`, which persists across
 *    app restarts inside the Tauri webview (and in a browser during development).
 *  - Export/import go through a Blob download and a file input, so no extra
 *    Tauri plugins or filesystem permissions are required.
 */

export const SAVE_FORMAT = 'eden0-save';
export const SAVE_VERSION = 1;

export const AUTOSAVE_KEY = 'eden0.autosave.v1';
export const MANUAL_SLOT_KEY = 'eden0.slot.v1';

export interface SaveEnvelope {
  format: string;
  version: number;
  savedAt: string;
  seed: string;
  tick: number;
  simTime: number;
  payload: unknown;
}

export interface UnwrapResult {
  ok: boolean;
  payload?: string;
  error?: string;
  seed?: string;
  tick?: number;
  savedAt?: string;
}

export function wrapSave(payloadJson: string, seed: string, tick: number, simTime: number): string {
  const envelope: SaveEnvelope = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    seed,
    tick,
    simTime,
    payload: JSON.parse(payloadJson),
  };
  return JSON.stringify(envelope);
}

export function unwrapSave(text: string): UnwrapResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not a valid save file (invalid JSON).' };
  }
  const envelope = parsed as Partial<SaveEnvelope>;
  if (envelope.format !== SAVE_FORMAT) {
    return { ok: false, error: `Not an EDEN//0 save (format "${String(envelope.format)}").` };
  }
  if (typeof envelope.version !== 'number' || envelope.version > SAVE_VERSION) {
    return {
      ok: false,
      error: `Save version ${String(envelope.version)} is newer than this build (${SAVE_VERSION}).`,
    };
  }
  if (!envelope.payload) return { ok: false, error: 'Save file contains no world payload.' };
  return {
    ok: true,
    payload: JSON.stringify(envelope.payload),
    seed: envelope.seed,
    tick: envelope.tick,
    savedAt: envelope.savedAt,
  };
}

function safeStorage(): Storage | null {
  try {
    const probe = '__eden0_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

export function writeAutosave(text: string): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    storage.setItem(AUTOSAVE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

export function readAutosave(): string | null {
  return safeStorage()?.getItem(AUTOSAVE_KEY) ?? null;
}

export function clearAutosave(): void {
  safeStorage()?.removeItem(AUTOSAVE_KEY);
}

export function writeManualSlot(text: string): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    storage.setItem(MANUAL_SLOT_KEY, text);
    return true;
  } catch {
    return false;
  }
}

export function readManualSlot(): string | null {
  return safeStorage()?.getItem(MANUAL_SLOT_KEY) ?? null;
}

export function downloadSave(text: string, seed: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `eden0-${seed}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickSaveFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
