// @ts-nocheck  (uses node fs; web has no @types/node)
import { describe, expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHand, parseHistory } from '../src/hh/parse';
import type { ParseResult, ReasonCode } from '../src/hh/types';

const dir = join(__dirname, '../src/hh/fixtures');
const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
const REASONS = new Set<ReasonCode>([
  'unsupported_format', 'tournament', 'unsupported_game', 'run_it_twice', 'bad_header', 'no_seats', 'no_button',
  'no_blinds', 'bad_structure', 'bad_card', 'duplicate_card', 'unknown_player', 'bad_action', 'bad_amount',
  'stack_overflow', 'pot_mismatch', 'truncated',
]);
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const sum = (o: Record<number, number>) => Object.values(o).reduce((a, b) => a + b, 0);

test('at least 12 fixtures', () => expect(files.length).toBeGreaterThanOrEqual(12));

describe.each(files)('%s', (f) => {
  const text = read(f);
  const { results } = parseHistory(text);

  test('has SYNTHETIC marker on first line', () => {
    expect(text.split('\n')[0]).toMatch(/^SYNTHETIC\b/);
  });

  test('every hand is parsed or reason-coded', () => {
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      if (r.ok) expect(r.hand.hand_id).toBeTruthy();
      else expect(REASONS.has(r.reason)).toBe(true);
    }
  });

  test('matches golden JSON', () => {
    const g = join(dir, f.replace(/\.txt$/, '.json'));
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(g, JSON.stringify(results, null, 2) + '\n');
    expect(existsSync(g)).toBe(true);
    expect(JSON.parse(JSON.stringify(results))).toEqual(JSON.parse(readFileSync(g, 'utf8')));
  });

  test('pot and stack invariants', () => {
    for (const r of results) {
      if (!r.ok) continue;
      const h = r.hand;
      expect(sum(h.contributions)).toBeCloseTo(h.final_pot, 3);
      const startSum = h.seats.reduce((a, s) => a + s.stack, 0);
      // rake is the only chips that may vanish; fixtures are rake-free
      expect(startSum - sum(h.final_stacks)).toBeCloseTo(h.final_pot - sum(h.collected), 3);
      expect(h.final_pot - sum(h.collected)).toBeGreaterThanOrEqual(-0.01);
      for (const s of h.seats) {
        expect(h.contributions[s.seat]).toBeLessThanOrEqual(s.stack + 0.01);
        expect(h.final_stacks[s.seat]).toBeGreaterThanOrEqual(-0.01);
      }
      for (const p of h.pot_by_street) expect(p.pot).toBeGreaterThan(0);
      const pots = h.pot_by_street.map((p) => p.pot);
      expect([...pots].sort((a, b) => a - b)).toEqual(pots); // non-decreasing
    }
  });
});

describe('expected classification', () => {
  const classes = (f: string) => parseHistory(read(f)).results.map((r) => (r.ok ? 'ok' : r.reason));
  test.each([
    ['ps_hu_srp_river.txt', ['ok']],
    ['multi_hands.txt', ['ok', 'ok', 'ok']],
    ['malformed_truncated.txt', ['truncated']],
    ['malformed_bad_action.txt', ['bad_action']],
    ['malformed_bad_card.txt', ['bad_card']],
    ['reject_tournament.txt', ['tournament']],
    ['reject_plo.txt', ['unsupported_game']],
    ['reject_other_site.txt', ['unsupported_format']],
    ['reject_garbage.txt', ['unsupported_format']],
  ])('%s', (f, want) => expect(classes(f)).toEqual(want));

  const ok = (f: string) => {
    const r = parseHistory(read(f)).results[0] as Extract<ParseResult, { ok: true }>;
    expect(r.ok).toBe(true);
    return r;
  };
  test('all-in with uncalled bet return', () => {
    const { hand } = ok('ps_allin_uncalled.txt');
    expect(hand.returned).toEqual([{ seat: 2, amount: 60 }]);
    expect(hand.final_pot).toBe(80);
    expect(hand.actions.map((a) => a.kind)).toEqual(['raise', 'allin', 'call']);
    expect(hand.final_stacks).toEqual({ 1: 80, 2: 60 });
  });
  test('hidden villain cards, hero known', () => {
    const { hand } = ok('gg_hu_hidden.txt');
    expect(hand.hero).toBe(1);
    expect(hand.hero_cards).toEqual(['9c', '9d']);
    expect(hand.site).toBe('ggpoker');
  });
  test('side pots flagged', () => expect(ok('gg_allin_side_pots.txt').warnings).toContain('side_pots'));
  test('check-raise recorded', () => {
    const k = ok('ps_checkraise_hu.txt').hand.actions.filter((a) => a.street === 'flop').map((a) => `${a.seat}:${a.kind}`);
    expect(k).toEqual(['6:check', '3:bet', '6:raise', '3:call']);
  });
});

describe('robustness', () => {
  test('never throws on garbage, empty or truncated input', () => {
    const base = read('ps_multiway_3bp.txt');
    const inputs = ['', '\n\n', 'x', '\u0000￿', null as unknown as string, undefined as unknown as string];
    for (let n = 0; n < base.length; n += 7) inputs.push(base.slice(0, n));
    for (const t of inputs) {
      const s = parseHistory(t);
      for (const r of s.results) expect(r.ok || REASONS.has(r.reason)).toBe(true);
    }
    expect(parseHand('').ok).toBe(false);
  });
});
