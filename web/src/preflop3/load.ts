import { migratePack } from './migrate';
import { validatePack } from './validate';
import type { Pack, PackError } from './types';

export type LoadResult = { ok: true; pack: Pack } | { ok: false; errors: PackError[] };
// The e2e build (vite --mode e2e, .env.e2e) sets VITE_P3_ALLOW_FIXTURE so tests can load the synthetic pack; production never does.
const isProd = (): boolean => !!import.meta.env?.PROD && !import.meta.env?.VITE_P3_ALLOW_FIXTURE;
const FIXTURE_ERR: PackError = { path: 'meta.verification', code: 'E_FIXTURE_IN_PROD', detail: "packs with verification 'test-fixture' are rejected in production builds" };

/** Migrates, then validates. `prod` defaults to import.meta.env.PROD; pass it explicitly in tests. */
export function loadPack(raw: unknown, opts: { prod?: boolean } = {}): LoadResult {
  const prod = opts.prod ?? isProd();
  if (prod && (raw as any)?.meta?.verification === 'test-fixture') return { ok: false, errors: [FIXTURE_ERR] };
  const m = migratePack(raw);
  if (!m.ok) return m;
  const v = validatePack(m.pack);
  return v.ok ? { ok: true, pack: m.pack as Pack } : { ok: false, errors: v.errors };
}

/** Whether a loaded pack may be offered in the pack picker. */
export function isSelectable(pack: Pack, opts: { prod?: boolean } = {}): boolean {
  return !((opts.prod ?? isProd()) && pack.meta.verification === 'test-fixture');
}
export function selectablePacks(packs: Pack[], opts: { prod?: boolean } = {}): Pack[] {
  return packs.filter((p) => isSelectable(p, opts));
}
