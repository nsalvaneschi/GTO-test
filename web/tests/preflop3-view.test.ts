import { describe, expect, it } from 'vitest';
import fixture from '../src/preflop3/fixtures/SYNTHETIC-TEST-ONLY.test-fixture.pack.json';
import { loadPack } from '../src/preflop3/load';
import { emptyStats, mulberry32, scoreAnswer } from '../src/preflop3/trainer';
import type { Pack } from '../src/preflop3/types';
import { CLASS_INDEX } from '../src/preflop3/types';
import * as V from '../src/preflop3/view';
import { e2eFiles, fixtureAtStack } from '../scripts/e2e-packs.mjs';

const load = (raw: unknown) => { const r = loadPack(raw, { prod: false }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.pack; };
const pack = load(fixture);
const node = (id: string) => pack.nodes.find((n) => n.id === id)!;

describe('stack modes', () => {
  it('derives 18/16 bb variants that validate, and rejects unequal stacks', () => {
    for (const s of [20, 18, 16]) { const p = load(fixtureAtStack(fixture, s)); expect(V.stackOf(p)).toBe(s); }
    const odd = structuredClone(pack) as Pack; odd.meta.stacksBb.SB = 18;
    expect(V.stackOf(odd)).toBeNull();
  });
  it('disables stacks without a pack and mix without any pack', () => {
    const m = new Map<number, Pack>([[20, pack]]);
    const st = V.modeStates(m);
    expect(st.modes.map((x) => [x.mode, x.enabled])).toEqual([['20', true], ['18', false], ['16', false], ['mix', true]]);
    expect(st.missing).toEqual([18, 16]);
    expect(V.modeStates(new Map()).modes.every((x) => !x.enabled)).toBe(true);
  });
  it('picks the fixed stack, or uniformly among the loaded ones for mix', () => {
    const m = new Map<number, Pack>([[20, pack], [16, load(fixtureAtStack(fixture, 16))]]);
    expect(V.pickPack('18', m, () => 0)).toBeNull();
    expect(V.pickPack('16', m, () => 0.9)!.stack).toBe(16);
    const rng = mulberry32(3), seen = { 20: 0, 16: 0 } as Record<number, number>;
    for (let i = 0; i < 400; i++) seen[V.pickPack('mix', m, rng)!.stack]++;
    expect(seen[20]).toBeGreaterThan(150); expect(seen[16]).toBeGreaterThan(150);
  });
});

describe('e2e pack files', () => {
  it('all validate, and the 16 bb pack has a close-tier answer (FOLD at n1)', () => {
    const f = e2eFiles();
    for (const s of [20, 18, 16]) expect(V.stackOf(load(JSON.parse(f[`${s}.json`])))).toBe(s);
    const p16 = load(JSON.parse(f['16.json'])), n1 = p16.nodes.find((n) => n.id === 'n1')!;
    const sc = scoreAnswer(n1, CLASS_INDEX['AKs'], 'F');
    expect([sc.correct, sc.close, V.verdictOf(sc)]).toEqual([false, true, 'close']);
  });
});

describe('badges, verdicts, payload', () => {
  it('maps verification to badge kind', () => {
    expect(V.badgeKind('external-verified')).toBe('verified');
    expect(V.badgeKind('self-computed-unverified')).toBe('unverified');
    expect(V.badgeKind('test-fixture')).toBe('test');
  });
  it('verdicts follow the trainer scoring (close counts as not correct)', () => {
    expect(V.verdictOf({ correct: true, close: false })).toBe('correct');
    expect(V.verdictOf({ correct: false, close: true })).toBe('close');
    expect(V.verdictOf({ correct: false, close: false })).toBe('incorrect');
  });
  it('builds the server body with spotId, position index, meta, EV loss (0 + evKnown=false when the pack has no EV)', () => {
    const n = node('n1'), ci = CLASS_INDEX['AKs'];
    const score = scoreAnswer(n, ci, 'R6');
    const b = V.resultBody({ stack: 20, pack, node: n, classIdx: ci, combo: 'AsKs', actionIdx: 2, score, ms: 1234.4, lang: 'es' });
    expect(b).toMatchObject({ spotId: 'preflop3:20:n1:SB', hero: 1, handCombo: 'AsKs', action: 2, evLoss: score.evLoss, ms: 1234, lang: 'es' });
    expect(score.evLoss).not.toBeNull();
    expect(b.solverFreqs).toBe(n.freq[ci]);
    expect(b.meta).toEqual({ packId: pack.meta.packId, verification: 'test-fixture', verdict: V.verdictOf(score), evKnown: true });
    const noEv = { ...n, ev: undefined }, s2 = scoreAnswer(noEv, ci, 'R6');
    const b2 = V.resultBody({ stack: 20, pack, node: noEv, classIdx: ci, combo: 'AsKs', actionIdx: 2, score: s2, ms: 5, lang: 'en' });
    expect(b2.evLoss).toBe(0); expect(b2.meta.evKnown).toBe(false);
    expect(V.spotIdOf(16, 'n2', 'BTN')).toBe('preflop3:16:n2:BTN');
  });
});

describe('seats, situation, buttons', () => {
  it('shows previous actions as chips and the dealer on the BTN', () => {
    const s = V.seatViews(node('n1'), pack);
    expect(s.map((x) => [x.pos, x.hero, x.dealer, x.chip.kind, x.chip.bb])).toEqual([['BTN', false, true, 'raise', 2], ['SB', true, false, 'blind', 0.5], ['BB', false, false, 'blind', 1]]);
    expect(V.seatViews(node('n2'), pack).find((x) => x.pos === 'SB')!.chip).toEqual({ kind: 'raise', bb: 6 });
    expect(V.seatViews(node('n0'), pack).find((x) => x.pos === 'BTN')!.chip.kind).toBe('none');
  });
  it('describes the situation', () => {
    expect(V.situationOf(node('n0'))).toEqual({ key: 'first', villain: null, sizeBb: null, folded: [] });
    expect(V.situationOf(node('n1'))).toMatchObject({ key: 'facingRaise', villain: 'BTN', sizeBb: 2 });
    expect(V.situationOf(node('n2'))).toMatchObject({ key: 'facing3bet', villain: 'SB', sizeBb: 6 });
    const bb = { ...node('n1'), actor: 'BB' as const, history: [{ pos: 'BTN' as const, act: 'R' as const, toBb: 2 }, { pos: 'SB' as const, act: 'F' as const, toBb: null }] };
    expect(V.situationOf(bb)).toMatchObject({ key: 'facingRaise', villain: 'BTN', folded: ['SB'] });
  });
  it('lists only existing actions, ordered, with sizes, and maps shortcuts', () => {
    const v = V.actionViews(node('n2'), pack);
    expect(v.map((x) => [x.actionId, x.button, x.sizeBb])).toEqual([['F', 'FOLD', null], ['C', 'CALL', 4], ['A', 'ALLIN', 20]]);
    expect(V.actionForKey(v, 'f')!.actionId).toBe('F');
    expect(V.actionForKey(v, 'a')!.actionId).toBe('A');
    expect(V.actionForKey(v, 'r')).toBeUndefined();
    expect(V.actionForKey(v, '3')).toBeUndefined();
    const v1 = V.actionViews(node('n1'), pack);
    expect(V.actionForKey(v1, 'r')).toBeUndefined(); // a raise after a raise is a 3-BET, not RAISE
    expect(v1.find((x) => x.actionId === 'R6')!.button).toBe('3BET');
    expect(V.actionForKey(v1, '3')!.actionId).toBe('R6');
    expect(V.actionViews(node('n0'), pack).map((x) => x.button)).toEqual(['FOLD', 'RAISE', 'ALLIN']);
  });
});

describe('matrix, session, server mapping', () => {
  it('has 169 cells in grid order with the hero class marked and unplayed classes empty', () => {
    const n = node('n0'), cells = V.matrixCells(n, 'AKo');
    expect(cells).toHaveLength(169);
    expect(cells[0].name).toBe('AA'); expect(cells[1].name).toBe('AKs'); expect(cells[13].name).toBe('AKo'); expect(cells[168].name).toBe('22');
    expect(cells.filter((c) => c.me).map((c) => c.name)).toEqual(['AKo']);
    expect(new Set(cells.map((c) => c.idx)).size).toBe(169);
    expect(V.cellBackground([0.25, 0.75], ['red', 'blue'])).toBe('linear-gradient(to right, red 0% 25%,blue 25% 100%)');
  });
  it('parses the stored session defensively', () => {
    expect(V.parseSession(null)).toEqual(emptyStats);
    expect(V.parseSession('{bad')).toEqual(emptyStats);
    expect(V.parseSession(JSON.stringify({ correct: 3, incorrect: 1, total: 4, scoreSum: 3 }))).toEqual({ correct: 3, incorrect: 1, total: 4, scoreSum: 3 });
    expect(V.parseSession(JSON.stringify({ correct: 3, incorrect: 1, total: 9, scoreSum: 3 }))).toEqual(emptyStats);
    expect(V.parseSession(JSON.stringify({ correct: -1, incorrect: 1, total: 0, scoreSum: 0 }))).toEqual(emptyStats);
  });
  it('maps the server progress group to scoreboard stats (close counts as incorrect)', () => {
    expect(V.fromServer({ correct: 5, close: 2, incorrect: 3, total: 10 })).toEqual({ correct: 5, incorrect: 5, total: 10, scoreSum: 5 });
  });
});
