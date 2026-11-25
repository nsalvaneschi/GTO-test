// @ts-nocheck  (uses node fs; web has no @types/node)
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHand, parseHistory } from '../src/hh/parse';

const dir = join(__dirname, '../src/hh/fixtures');
const read = (f: string) => readFileSync(join(dir, f + '.txt'), 'utf8');
const ok = (f: string) => {
  const r = parseHand(read(f));
  if (!r.ok) throw new Error(f + ' rejected: ' + r.reason);
  return r;
};
const sum = (o: Record<number, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const ALL = ['ipk_hu_srp_river', 'ipk_3h_flop', 'ipk_6max_3bp', 'ipk_allin_side_pot', 'ipk_uncalled_river',
  'ipk_fold_preflop', 'ipk_checkraise_hu', 'ipk_limp_pot', 'ipk_late_joiner_dead_sb'];

describe('iPoker adapter (SYNTHETIC fixtures)', () => {
  test.each(ALL)('%s: site and arithmetic invariants', (f) => {
    const { hand: h } = ok(f);
    expect(h.site).toBe('ipoker');
    expect(sum(h.contributions)).toBeCloseTo(h.final_pot, 3);
    const start = h.seats.reduce((a, s) => a + s.stack, 0);
    expect(start - sum(h.final_stacks)).toBeCloseTo(h.final_pot - sum(h.collected), 3); // = rake
    expect(h.final_pot - sum(h.collected)).toBeGreaterThanOrEqual(-0.01);
    for (const s of h.seats) expect(h.final_stacks[s.seat]).toBeGreaterThanOrEqual(-0.01);
  });

  test('heads-up: amounts in bb, raise is total-to, call is incremental', () => {
    const { hand: h } = ok('ipk_hu_srp_river');
    expect(h.stakes).toEqual({ sb: 0.1, bb: 0.2 });
    expect(h.played_at).toBe('2024-02-01T10:00:00');
    expect(h.button).toBe(3);
    expect(h.hero).toBe(3);
    expect(h.hero_cards).toEqual(['As', 'Kh']);
    expect(h.board).toEqual(['2s', '7h', 'Kd', 'Qc', '3d']);
    expect(h.actions[0]).toMatchObject({ street: 'preflop', seat: 3, kind: 'raise', amount_to: 3 });
    expect(h.actions[1]).toMatchObject({ seat: 7, kind: 'call', amount_to: 3 });
    expect(h.final_pot).toBe(29);
    expect(h.collected[3]).toBe(27.5); // pot minus 0.30 rake
    expect(h.went_to_showdown).toBe(true);
    expect(h.showdown).toEqual([{ seat: 3, cards: ['As', 'Kh'] }]);
  });

  test('ten is written 10 and mapped to T', () => {
    expect(ok('ipk_3h_flop').hand.hero_cards).toEqual(['Jc', 'Td']);
    expect(ok('ipk_uncalled_river').hand.hero_cards).toEqual(['Js', 'Th']);
  });

  test('uncalled bets are derived and returned', () => {
    const a = ok('ipk_3h_flop').hand;
    expect(a.returned).toEqual([{ seat: 1, amount: 3 }]);
    expect(a.final_pot).toBe(6.5);
    expect(ok('ipk_uncalled_river').hand.returned).toEqual([{ seat: 2, amount: 15 }]);
    expect(ok('ipk_fold_preflop').hand.returned).toEqual([{ seat: 4, amount: 1.5 }]);
  });

  test('6-handed with seat numbers up to 10 and a short-stack mix', () => {
    const { hand: h } = ok('ipk_6max_3bp');
    expect(h.seats.map((s) => s.seat)).toEqual([2, 3, 5, 6, 8, 10]);
    expect(h.button).toBe(8);
    expect(h.hero).toBe(8);
    expect(h.blinds.map((b) => [b.seat, b.kind])).toEqual([[10, 'sb'], [2, 'bb']]);
    expect(h.actions.filter((a) => a.street === 'preflop').map((a) => a.kind))
      .toEqual(['fold', 'fold', 'raise', 'call', 'raise', 'fold', 'fold', 'call']);
    expect(h.seats.find((s) => s.seat === 5).stack).toBe(150);
  });

  test('all-in: Allin amount is chips added; side pots and returned excess', () => {
    const r = ok('ipk_allin_side_pot');
    expect(r.warnings).toContain('side_pots');
    const a = r.hand.actions;
    expect(a.map((x) => [x.kind, x.allin, x.amount_to])).toEqual([['allin', true, 50], ['allin', true, 150], ['call', true, 100]]);
    expect(r.hand.returned).toEqual([{ seat: 2, amount: 50 }]);
    expect(r.hand.collected).toEqual({ 1: 150, 2: 100 });
    expect(r.hand.showdown.length).toBe(3);
  });

  test('check-raise keeps total-to semantics', () => {
    const f = ok('ipk_checkraise_hu').hand.actions.filter((a) => a.street === 'flop');
    expect(f.map((a) => [a.seat, a.kind, a.amount_to])).toEqual([[2, 'check', null], [1, 'bet', 2], [2, 'raise', 6], [1, 'call', 6]]);
  });

  test('limp pot: preflop calls are incremental', () => {
    const p = ok('ipk_limp_pot').hand.actions.filter((a) => a.street === 'preflop');
    expect(p.map((a) => [a.kind, a.amount_to])).toEqual([['call', 1], ['call', 1], ['call', 1], ['check', null]]);
  });

  test('late joiner BB+dead SB: only BB is live and dead money is not returned', () => {
    const { hand: h } = ok('ipk_late_joiner_dead_sb');
    expect(h.blinds[2]).toEqual({ seat: 5, kind: 'sb+bb', amount: 1.5 });
    expect(h.actions[0]).toMatchObject({ seat: 5, kind: 'check' });
    expect(h.returned).toEqual([{ seat: 5, amount: 2 }]);
    expect(h.final_pot).toBe(3.5);
  });

  test('no Dealt line: parsed with no_hero', () => {
    const r = ok('ipk_fold_preflop');
    expect(r.hand.hero).toBeNull();
    expect(r.warnings).toContain('no_hero');
  });

  test('CRLF multi-hand file with euro amounts splits into two hands', () => {
    const s = parseHistory(read('ipk_multi_hands_crlf'));
    expect(s.results.length).toBe(2);
    expect(s.counts.ok).toBe(2);
    expect(s.results.map((r) => r.ok && r.hand.hand_id)).toEqual(['700000000015', '700000000016']);
  });

  test.each([
    ['malformed_ipk_bad_action', 'bad_action'],
    ['malformed_ipk_bad_section', 'bad_structure'],
    ['malformed_ipk_truncated', 'truncated'],
    ['malformed_ipk_pot_mismatch', 'pot_mismatch'],
    ['reject_ipk_omaha', 'unsupported_game'],
  ])('%s is rejected with %s', (f, reason) => {
    const r = parseHand(read(f));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
    expect(r.site).toBe('ipoker');
  });

  test('never throws on mutated input', () => {
    const base = read('ipk_6max_3bp').split('\n');
    for (let i = 1; i < base.length; i++) {
      for (const mut of ['', 'garbage line', base[i].toUpperCase(), base[i].replace(/\d/g, 'x'), '*** RIVER *** [S2]']) {
        const t = base.map((l, j) => (j === i ? mut : l)).join('\n');
        expect(() => parseHistory(t)).not.toThrow();
      }
    }
  });
});
