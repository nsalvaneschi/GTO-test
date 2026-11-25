// Pack sources for the trainer: static index (/packs/preflop3/index.json) + browser-only imports kept in IndexedDB.
// Imported files never leave the device. Every pack goes through loadPack (migrate + validate + fixture gate).
import { loadPack } from './load';
import { stackOf } from './view';
import type { Pack, PackError } from './types';

export interface UiError { path: string; code: string; detail: string }
export const MAX_PACK_BYTES = 20 * 1024 * 1024;
const BASE = '/packs/preflop3/';
const DB = 'gto-preflop3', STORE = 'packs';

export interface Loaded { packs: Map<number, Pack>; errors: { file: string; errors: UiError[] }[] }

/** Validates raw JSON text; unsupported stacks are reported like validator errors. */
export function parsePackText(text: string): { ok: true; pack: Pack; stack: number } | { ok: false; errors: UiError[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, errors: [{ path: '', code: 'E_JSON', detail: String((e as Error).message) }] }; }
  const r = loadPack(raw);
  if (!r.ok) return { ok: false, errors: r.errors as PackError[] };
  const stack = stackOf(r.pack);
  if (stack === null) return { ok: false, errors: [{ path: 'meta.stacksBb', code: 'E_STACK_UNSUPPORTED', detail: 'stacks must be equal and 20, 18 or 16 bb' }] };
  return { ok: true, pack: r.pack, stack };
}

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const q = indexedDB.open(DB, 1);
    q.onupgradeneeded = () => q.result.createObjectStore(STORE);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
const tx = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  idb().then((db) => new Promise<T>((res, rej) => { const r = f(db.transaction(STORE, mode).objectStore(STORE)); r.onsuccess = () => { res(r.result); db.close(); }; r.onerror = () => { rej(r.error); db.close(); }; }));
export const savePack = (text: string, key: string) => tx('readwrite', (s) => s.put(text, key)).catch(() => undefined);
const storedPacks = (): Promise<string[]> => tx('readonly', (s) => s.getAll() as IDBRequest<string[]>).catch(() => []);

async function staticTexts(): Promise<{ file: string; text: string }[]> {
  try {
    const r = await fetch(BASE + 'index.json', { cache: 'no-cache' });
    if (!r.ok) return [];
    const j = await r.json();
    const files: unknown[] = Array.isArray(j) ? j : Array.isArray(j?.packs) ? j.packs : [];
    const out: { file: string; text: string }[] = [];
    for (const f of files) {
      if (typeof f !== 'string' || !/^[\w.-]{1,64}\.json$/.test(f)) continue;
      try { const p = await fetch(BASE + f, { cache: 'no-cache' }); if (p.ok) out.push({ file: f, text: await p.text() }); } catch { /* unreachable file: skipped */ }
    }
    return out;
  } catch { return []; } // missing or malformed index = no static packs
}

/** All usable packs by stack: static first, then imported ones (an import replaces the static pack of the same stack). */
export async function loadAll(): Promise<Loaded> {
  const out: Loaded = { packs: new Map(), errors: [] };
  const srcs = [...(await staticTexts()), ...(await storedPacks()).map((text, i) => ({ file: `import-${i + 1}`, text }))];
  for (const { file, text } of srcs) {
    const r = parsePackText(text);
    if (r.ok) out.packs.set(r.stack, r.pack); else out.errors.push({ file, errors: r.errors });
  }
  return out;
}

/** Import a user-chosen JSON file: validates, stores in IndexedDB, returns the pack or the error list. */
export async function importFile(file: File): Promise<{ ok: true; pack: Pack; stack: number } | { ok: false; errors: UiError[] }> {
  if (file.size > MAX_PACK_BYTES) return { ok: false, errors: [{ path: '', code: 'E_TOO_LARGE', detail: String(file.size) }] };
  const text = await file.text();
  const r = parsePackText(text);
  if (r.ok) await savePack(text, r.pack.meta.packId);
  return r;
}
