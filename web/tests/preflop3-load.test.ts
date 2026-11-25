import { describe, expect, it } from 'vitest';
import fixture from '../src/preflop3/fixtures/SYNTHETIC-TEST-ONLY.test-fixture.pack.json';
import { isSelectable, loadPack, selectablePacks } from '../src/preflop3/load';
import type { Pack } from '../src/preflop3/types';

const fresh = () => structuredClone(fixture) as unknown as Pack;

describe('loadPack', () => {
  it('loads the fixture in dev', () => {
    const r = loadPack(fresh(), { prod: false });
    expect(r.ok).toBe(true);
  });
  it('rejects the fixture in prod with a clear error, even if otherwise invalid', () => {
    for (const raw of [fresh(), { meta: { verification: 'test-fixture' } }]) {
      const r = loadPack(raw, { prod: true });
      expect(!r.ok && r.errors[0].code).toBe('E_FIXTURE_IN_PROD');
      expect(!r.ok && r.errors[0].detail).toMatch(/rejected in production/);
    }
  });
  it('accepts non-fixture packs in prod and reports validation errors', () => {
    const p: any = fresh();
    p.meta.verification = 'self-computed-unverified';
    expect(loadPack(p, { prod: true }).ok).toBe(true);
    p.nodes[1].freq[0] = [1, 1, 1];
    const r = loadPack(p, { prod: true });
    expect(!r.ok && r.errors.some((e) => e.code === 'E_SUM')).toBe(true);
  });
  it('unknown schema version is a clear error', () => {
    const p: any = fresh();
    p.meta.schemaVersion = 7;
    const r = loadPack(p, { prod: false });
    expect(!r.ok && r.errors[0].code).toBe('E_SCHEMA_VERSION');
  });
  it('fixture is never selectable in prod', () => {
    expect(isSelectable(fresh(), { prod: true })).toBe(false);
    expect(isSelectable(fresh(), { prod: false })).toBe(true);
    expect(selectablePacks([fresh()], { prod: true })).toEqual([]);
  });
  it('fixture is clearly marked synthetic', () => {
    const f: any = fixture;
    expect(f.meta.verification).toBe('test-fixture');
    expect(f.meta.packId).toContain('SYNTHETIC_TEST_ONLY');
    expect(f.meta.notes).toMatch(/SYNTHETIC \/ TEST ONLY/);
  });
});
