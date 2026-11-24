import { expect, test } from 'vitest';
import { replayAt, type StoredHand } from '../src/hh/replay';

// SYNTHETIC stored hand: hero (seat 1) opens to 3, villain calls, hero folds to a flop bet.
const h = { site: 'pokerstars', hand_id: '1', stakes: { sb: 0.5, bb: 1 }, seats: [{ seat: 1, stack: 100, is_hero: true }, { seat: 2, stack: 100, is_hero: false }], hero_cards: null, board: ['Kh', 'Qd', '7s'],
  actions: [{ street: 'preflop', seat: 1, kind: 'raise', amount_to: 3 }, { street: 'preflop', seat: 2, kind: 'call', amount_to: 3 },
    { street: 'flop', seat: 2, kind: 'bet', amount_to: 4 }, { street: 'flop', seat: 1, kind: 'fold', amount_to: null }], pot_by_street: [1.5, 6] } as StoredHand;

test('stacks list every seat, including a folded hero (was villain only)', () => {
  const s = replayAt(h, 4);
  expect(s.folded).toEqual([1]);
  expect(s.stacks).toEqual({ 1: 97, 2: 93 });
});
