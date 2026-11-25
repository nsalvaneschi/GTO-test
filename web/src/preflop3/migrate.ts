import { CURRENT_SCHEMA_VERSION, type PackError } from './types';

/** migrations[v] upgrades a pack from schemaVersion v to v+1. Empty until a v2 exists. */
export const migrations: Record<number, (pack: any) => any> = {};

export type MigrateResult = { ok: true; pack: unknown } | { ok: false; errors: PackError[] };

export function migratePack(
  raw: unknown,
  opts: { current?: number; table?: Record<number, (pack: any) => any> } = {},
): MigrateResult {
  const current = opts.current ?? CURRENT_SCHEMA_VERSION;
  const table = opts.table ?? migrations;
  const fail = (detail: string): MigrateResult => ({ ok: false, errors: [{ path: 'meta.schemaVersion', code: 'E_SCHEMA_VERSION', detail }] });
  let pack: any = raw;
  let v = pack?.meta?.schemaVersion;
  if (!Number.isInteger(v) || v < 1) return fail(`schemaVersion must be a positive integer, got ${String(v)}`);
  if (v > current) return fail(`unknown schemaVersion ${v} (newer than supported ${current})`);
  while (v < current) {
    const fn = table[v];
    if (!fn) return fail(`no migration from schemaVersion ${v}`);
    pack = fn(structuredClone(pack));
    v += 1;
    pack.meta.schemaVersion = v;
  }
  return { ok: true, pack };
}
