import { describe, expect, it } from 'vitest';
import fixture from '../src/preflop3/fixtures/SYNTHETIC-TEST-ONLY.test-fixture.pack.json';
import { validatePack } from '../src/preflop3/validate';
import { migratePack } from '../src/preflop3/migrate';
import { CLASSES, type ErrorCode, type Pack } from '../src/preflop3/types';

const fresh = () => structuredClone(fixture) as unknown as Pack;
const idx = (c: string) => CLASSES.indexOf(c);

describe('validatePack', () => {
  it('accepts the fixture', () => {
    const r = validatePack(fresh());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  const cases: [ErrorCode, string, (p: any) => void][] = [
    ['E_STRUCTURE', 'nodes', (p) => { p.nodes = []; }],
    ['E_SCHEMA_VERSION', 'meta.schemaVersion', (p) => { p.meta.schemaVersion = 99; }],
    ['E_VERIFICATION', 'meta.verification', (p) => { p.meta.verification = 'gto-certified'; }],
    ['E_META_FIELD', 'meta.license', (p) => { delete p.meta.license; }],
    ['E_ICM_PAYOUTS', 'meta.icmPayouts', (p) => { p.meta.payoff = 'ICM'; }],
    ['E_CLASSES', 'classes', (p) => { p.classes.pop(); }],
    ['E_DUP_ID', 'nodes[n1]', (p) => { p.nodes[2].id = 'n1'; }],
    ['E_ACTOR', 'nodes[n0].actor', (p) => { p.nodes[0].actor = 'CO'; }],
    ['E_HISTORY', 'nodes[n1].history', (p) => { p.nodes[1].history = [{ pos: 'BTN', act: 'X' }]; }],
    ['E_ACTION_KIND', 'nodes[n0].actions[F].kind', (p) => { p.nodes[0].actions[0].kind = 'bluff'; }],
    ['E_CHILD_MISSING', 'nodes[n0].actions[R2].child', (p) => { p.nodes[0].actions[1].child = 'n99'; }],
    ['E_TERMINAL', 'nodes[n0].actions[F].terminal', (p) => { p.nodes[0].actions[0].terminal = 'maybe'; }],
    ['E_UNREACHABLE', 'nodes[n2]', (p) => { p.nodes[1].actions[2] = { id: 'R6', kind: 'raise', toBb: 6, child: null, terminal: 'flop' }; }],
    ['E_CLASS_COVERAGE', 'nodes[n0].freq', (p) => { p.nodes[0].freq.pop(); }],
    ['E_ROW_WIDTH', 'nodes[n0].freq[AA]', (p) => { p.nodes[0].freq[0] = [0.5, 0.5]; }],
    ['E_NUMBER', 'nodes[n1].freq[AKo][1]', (p) => { p.nodes[1].freq[idx('AKo')] = [0.5, NaN, 0.5]; }],
    ['E_SUM', 'nodes[n1].freq[AKo]', (p) => { p.nodes[1].freq[idx('AKo')] = [0.5, 0.3, 0.3]; }],
    ['E_EV_SHAPE', 'nodes[n1].ev[AA]', (p) => { p.nodes[1].ev[0] = [0, 1]; }],
    ['E_POT', 'nodes[n1].potBb', (p) => { p.nodes[1].potBb = 99; }],
    ['E_TOCALL', 'nodes[n1].toCallBb', (p) => { p.nodes[1].toCallBb = 0.5; }],
    ['E_STACK', 'nodes[n2].stacksBb.SB', (p) => { p.nodes[2].stacksBb.SB = 20; }],
    ['E_TOBB', 'nodes[n0].actions[A].toBb', (p) => { p.nodes[0].actions[2].toBb = 25; }],
  ];
  for (const [code, path, mutate] of cases) {
    it(`${code} at ${path}`, () => {
      const p: any = fresh();
      mutate(p);
      const r = validatePack(p);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.code === code && e.path === path)).toBe(true);
    });
  }

  it('rejects negative and >1 values and reports all errors at once', () => {
    const p: any = fresh();
    p.nodes[1].freq[0] = [-0.1, 0.6, 0.5];
    p.nodes[1].freq[1] = [1.5, 0, -0.5];
    p.meta.packId = '';
    const codes = validatePack(p).errors.map((e) => `${e.code}@${e.path}`);
    expect(codes).toContain('E_NUMBER@nodes[n1].freq[AA][0]');
    expect(codes).toContain('E_NUMBER@nodes[n1].freq[AKs][2]');
    expect(codes).toContain('E_META_FIELD@meta.packId');
  });
  it('non-object input gives E_STRUCTURE', () => {
    expect(validatePack(null).errors[0].code).toBe('E_STRUCTURE');
  });
});

describe('migratePack', () => {
  it('passes the current version through', () => {
    expect(migratePack(fresh()).ok).toBe(true);
  });
  it('rejects unknown (newer) and invalid versions with E_SCHEMA_VERSION', () => {
    const p: any = fresh();
    p.meta.schemaVersion = 2;
    const r = migratePack(p);
    expect(!r.ok && r.errors[0].code).toBe('E_SCHEMA_VERSION');
    p.meta.schemaVersion = 'x';
    expect(migratePack(p).ok).toBe(false);
  });
  it('runs the migration hook chain for older versions', () => {
    const p: any = fresh();
    p.meta.schemaVersion = 1;
    const r = migratePack(p, { current: 2, table: { 1: (x) => ({ ...x, migrated: true }) } });
    expect(r.ok && (r.pack as any).migrated).toBe(true);
    expect(r.ok && (r.pack as any).meta.schemaVersion).toBe(2);
    expect(migratePack(p, { current: 2, table: {} }).ok).toBe(false);
  });
});
