import { describe, expect, it } from 'vitest';
import fixture from '../src/preflop3/fixtures/SYNTHETIC-TEST-ONLY.test-fixture.pack.json';
import { validatePack } from '../src/preflop3/validate';
import { CLASSES, comboCount, type Pack } from '../src/preflop3/types';
import {
  accuracyPct, buildSpots, buttonOf, dealHand, describeSituation, emptyStats, explain, mapButtons, mulberry32,
  sampleSpot, scoreAnswer, sessionReducer,
} from '../src/preflop3/trainer';

const pack = fixture as unknown as Pack;
const node = (id: string, p = pack) => p.nodes.find((n) => n.id === id)!;
const ci = (c: string) => CLASSES.indexOf(c);

/** Fixture re-scaled to another uniform stack depth (blinds-only committed amounts are unchanged). */
function withStack(s: number): Pack {
  const p = structuredClone(pack);
  p.meta.stacksBb = { BTN: s, SB: s, BB: s };
  p.meta.packId += `_${s}`;
  const rem: Record<string, [number, number, number]> = { n0: [0, 0.5, 1], n1: [2, 0.5, 1], n2: [2, 6, 1] };
  for (const n of p.nodes) {
    n.stacksBb = { BTN: s - rem[n.id][0], SB: s - rem[n.id][1], BB: s - rem[n.id][2] };
    for (const a of n.actions) if (a.kind === 'allin') a.toBb = s;
  }
  return p;
}

describe('stack settings', () => {
  for (const s of [20, 18, 16]) {
    it(`${s}bb pack validates and builds spots`, () => {
      const p = withStack(s);
      expect(validatePack(p).errors).toEqual([]);
      expect(buildSpots(p)).toHaveLength(3);
      expect(describeSituation(node('n2', p), p).effectiveStackBb).toBe(s);
    });
  }
});

describe('spots and reach', () => {
  const spots = buildSpots(pack);
  const byId = Object.fromEntries(spots.map((s) => [s.nodeId, s]));
  it('derives hero reach from own earlier actions', () => {
    expect(byId.n0.heroReach[ci('AA')]).toBe(1);
    expect(byId.n2.heroReach[ci('AA')]).toBe(1);   // pairs raise 100% at n0
    expect(byId.n2.heroReach[ci('AKs')]).toBe(0.5);
    expect(byId.n2.heroReach[ci('AKo')]).toBe(0);  // offsuit never opens, row null
  });
  it('node weight = product of the three players range masses (card removal ignored)', () => {
    const btn = (13 * 6 + 78 * 4 * 0.5) / 1326;
    expect(byId.n0.weight).toBeCloseTo(1, 12);
    expect(byId.n1.weight).toBeCloseTo(btn, 12);
    expect(byId.n2.weight).toBeCloseTo(btn * 0.6, 12);
  });
});

describe('sampling', () => {
  const spots = buildSpots(pack);
  it('hands are reach-weighted (chi-square, 20k samples, seeded) and never reach-0', () => {
    const rng = mulberry32(12345);
    const spot = spots.find((s) => s.nodeId === 'n2')!;
    const N = 20000, counts = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      const d = dealHand(spot, rng);
      expect(spot.heroReach[d.classIdx]).toBeGreaterThan(0);
      expect(CLASSES[d.classIdx].endsWith('o')).toBe(false);
      counts.set(d.classIdx, (counts.get(d.classIdx) ?? 0) + 1);
    }
    const total = spot.heroReach.reduce((s, r, i) => s + r * comboCount(CLASSES[i]), 0);
    let chi2 = 0, cells = 0;
    spot.heroReach.forEach((r, i) => {
      if (!r) return;
      const e = (N * r * comboCount(CLASSES[i])) / total;
      chi2 += (( counts.get(i) ?? 0) - e) ** 2 / e;
      cells++;
    });
    expect(cells).toBe(91);
    expect(chi2).toBeLessThan(135); // df=90, p=0.001 critical ~ 126.1 (with margin)
  });
  it('deals concrete cards matching the class', () => {
    const rng = mulberry32(7);
    const spot = spots[0];
    for (let i = 0; i < 500; i++) {
      const d = dealHand(spot, rng), [a, b] = d.cards, c = CLASSES[d.classIdx];
      expect(a).not.toBe(b);
      expect(a[0]).toBe(c[0]);
      expect(b[0]).toBe(c[1]);
      if (c[2] === 's') expect(a[1]).toBe(b[1]);
      if (c[2] === 'o') expect(a[1]).not.toBe(b[1]);
    }
  });
  it('spots sampled by reach vs uniform; position filter', () => {
    const N = 20000;
    const count = (opts: object, seed: number) => {
      const rng = mulberry32(seed), c: Record<string, number> = {};
      for (let i = 0; i < N; i++) { const s = sampleSpot(spots, rng, opts); c[s.nodeId] = (c[s.nodeId] ?? 0) + 1; }
      return c;
    };
    const tot = spots.reduce((a, s) => a + s.weight, 0);
    const weighted = count({}, 1);
    const chi = spots.reduce((a, s) => { const e = (N * s.weight) / tot; return a + ((weighted[s.nodeId] ?? 0) - e) ** 2 / e; }, 0);
    expect(chi).toBeLessThan(13.8); // df=2, p=0.001
    const uni = count({ uniformSpots: true }, 2);
    const chiU = spots.reduce((a, s) => a + ((uni[s.nodeId] ?? 0) - N / 3) ** 2 / (N / 3), 0);
    expect(chiU).toBeLessThan(13.8);
    const sb = count({ positionFilter: 'SB' }, 3);
    expect(Object.keys(sb)).toEqual(['n1']);
  });
});

describe('button mapping', () => {
  it('maps fold/call/raise/3-bet/all-in', () => {
    expect(mapButtons(node('n0'), pack).map((b) => b.button)).toEqual(['FOLD', 'RAISE', 'ALLIN']);
    expect(mapButtons(node('n1'), pack).map((b) => b.button)).toEqual(['FOLD', 'CALL', '3BET']);
    expect(mapButtons(node('n2'), pack).map((b) => b.button)).toEqual(['FOLD', 'CALL', 'ALLIN']);
  });
  it('raise >= 95% of effective stack is ALL-IN; several sizes share one button', () => {
    const p = structuredClone(pack);
    const n = node('n0', p);
    n.actions.splice(2, 0, { id: 'R3', kind: 'raise', toBb: 3, child: null, terminal: 'flop' }, { id: 'R19', kind: 'raise', toBb: 19, child: null, terminal: 'showdown-allin' });
    expect(buttonOf(n.actions[3], n, p)).toBe('ALLIN');       // 19 >= 0.95*20
    expect(buttonOf(n.actions[2], n, p)).toBe('RAISE');
    const raise = mapButtons(n, p).find((b) => b.button === 'RAISE')!;
    expect(raise.actionIds).toEqual(['R2', 'R3']);
    expect(raise.sizesBb).toEqual([2, 3]);
  });
  it('check label when nothing to call', () => {
    const p = structuredClone(pack);
    const n = node('n1', p);
    n.toCallBb = 0;
    expect(mapButtons(n, p).find((b) => b.button === 'CALL')!.isCheck).toBe(true);
  });
  it('describes the situation', () => {
    const s = describeSituation(node('n2'), pack);
    expect(s).toMatchObject({ hero: 'BTN', potBb: 9, toCallBb: 4, effectiveStackBb: 20 });
    expect(s.rivals.find((r) => r.pos === 'SB')!.actions).toEqual([{ act: 'R', toBb: 6 }]);
  });
});

describe('scoring (fixture n1: fold 10 / call 30 / raise 60)', () => {
  const n1 = node('n1');
  const aa = ci('AA');
  it('all three actions correct at default threshold 10%', () => {
    for (const id of ['F', 'C', 'R6']) expect(scoreAnswer(n1, aa, id).correct).toBe(true);
    expect(scoreAnswer(n1, aa, 'R6').bestActionId).toBe('R6');
  });
  it('fold is correct only when freq >= threshold', () => {
    expect(scoreAnswer(n1, aa, 'F', { threshold: 0.1 }).correct).toBe(true);
    expect(scoreAnswer(n1, aa, 'F', { threshold: 0.11 }).correct).toBe(false);
    expect(scoreAnswer(n1, aa, 'C', { threshold: 0.31 }).correct).toBe(false);
  });
  it('strict mode scores by frequency', () => {
    expect(scoreAnswer(n1, aa, 'C', { strict: true }).score).toBe(0.3);
    expect(scoreAnswer(n1, aa, 'R6', { strict: true }).score).toBe(0.6);
    expect(scoreAnswer(n1, aa, 'R6').score).toBe(1);
  });
  it('close tier from EV loss, counted incorrect', () => {
    const r = scoreAnswer(n1, aa, 'F', { threshold: 0.5 });
    expect(r.correct).toBe(false);
    expect(r.evLoss).toBeCloseTo(0.15);
    expect(r.close).toBe(false);
    expect(scoreAnswer(n1, aa, 'F', { threshold: 0.5, closeEvLossBb: 0.2 }).close).toBe(true);
    expect(scoreAnswer(node('n0'), aa, 'F').evLoss).toBeNull();
  });
  it('zero-frequency action is incorrect; reach-0 class throws', () => {
    expect(scoreAnswer(node('n0'), aa, 'F').correct).toBe(false);
    expect(() => scoreAnswer(node('n2'), ci('AKo'), 'F')).toThrow();
  });
});

describe('explanation params and session stats', () => {
  it('explanation uses only pack data', () => {
    const spot = buildSpots(pack).find((s) => s.nodeId === 'n2')!;
    const e = explain(node('n2'), pack, spot, ci('AA'), 'A');
    expect(e).toMatchObject({ handClass: 'AA', potBb: 9, toCallBb: 4, chosenFreq: 0.5, bestActionId: 'A', evLoss: null });
    expect(e.potOdds).toBeCloseTo(4 / 13);
    expect(e.spr).toBeCloseTo(18 / 9);
    expect(e.freqs.map((f) => f.button)).toEqual(['FOLD', 'CALL', 'ALLIN']);
    expect(e.chosenRangeRank).toBe(0);
  });
  it('reducer and accuracy', () => {
    let s = emptyStats;
    s = sessionReducer(s, { correct: true, score: 1 });
    s = sessionReducer(s, { correct: false, score: 0 });
    s = sessionReducer(s, { correct: true, score: 1 });
    expect(s).toMatchObject({ correct: 2, incorrect: 1, total: 3 });
    expect(accuracyPct(s)).toBeCloseTo(66.667, 2);
    expect(accuracyPct(emptyStats)).toBe(0);
    const t = sessionReducer(sessionReducer(emptyStats, { correct: true, score: 0.6 }), { correct: false, score: 0.05 });
    expect(accuracyPct(t, true)).toBeCloseTo(32.5);
  });
});
