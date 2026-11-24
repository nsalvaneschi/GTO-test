import { describe, expect, it } from 'vitest';
import { normalizeBoard, validChips } from '../src/validate';
import { verdictOf, CLOSE_EV_LOSS } from '../src/drill';

describe('normalizeBoard', () => {
  const ok = (s: string) => { const r = normalizeBoard(s); return r.ok ? r.board : r.err; };
  it('accepts spaced, lowercase, padded and unspaced boards', () => {
    for (const s of ['As Kd 7c 4h 2s', 'as kd 7c 4h 2s', '  As   Kd 7c  4h 2s ', 'AsKd7c4h2s', 'AS KD 7C 4H 2S']) expect(ok(s)).toBe('As Kd 7c 4h 2s');
  });
  it('rejects bad boards with a code', () => {
    expect(ok('As As 7c 4h 2s')).toBe('board.dup');
    expect(ok('XX')).toBe('board.cards');
    expect(ok('')).toBe('board.count');
    expect(ok('As Kd 7c')).toBe('board.count');
    expect(ok('As Kd 7c 4h 2s 3c')).toBe('board.count');
    expect(ok('1s Kd 7c 4h 2s')).toBe('board.cards');
    expect(ok('Asx Kd 7c 4h 2s')).toBe('board.cards');
  });
});
describe('validChips', () => {
  it('requires a finite number in (0, 1e6]', () => {
    for (const x of [10, 2.5, 1e6]) expect(validChips(x)).toBe(true);
    for (const x of [0, -5, NaN, Infinity, 1e300, 1e6 + 1]) expect(validChips(x)).toBe(false);
  });
});
describe('verdictOf (three levels)', () => {
  it('correct when the solver plays it >= 10%, close when rare but cheap, else mistake', () => {
    expect(verdictOf([0.1, 0.9], 0, 5)).toBe('correct');
    expect(verdictOf([0.09, 0.91], 0, CLOSE_EV_LOSS - 0.01)).toBe('close');
    expect(verdictOf([0.09, 0.91], 0, CLOSE_EV_LOSS)).toBe('mistake');
    expect(verdictOf([0, 1], 0, 12)).toBe('mistake');
  });
});
