// @ts-nocheck  (uses node fs; web has no @types/node)
// Regression for a once-seen unreproduced hang with a 6-card board: 0..8 card boards at both layers, 10 s time-box each.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSync, Solver } from '../src/wasm/gto_wasm.js';
import { normalizeBoard } from '../src/validate';
import { parseRange, presets } from '../src/ranges';

initSync({ module: readFileSync(join(__dirname, '../src/wasm/gto_wasm_bg.wasm')) });
const DECK = ['As', 'Kd', '7c', '4h', '2s', '3c', '9d', 'Jh'];
const board = (n: number) => DECK.slice(0, n).join(' ');
const cfg = (b: string, n: number) => JSON.stringify({ board: b, ranges: [parseRange(presets.mixed), parseRange(presets.mixed)], streets: Array.from({ length: Math.min(3, Math.max(1, 6 - n)) }, () => ({ pot: 10, stack: 50, sizes: [0.5], raise_cap: 1 })), budget_mb: 1024 });
/** Runs fn (a synchronous wasm call wrapped in a promise) against a 10 s timer; a hang in a sync call would also trip the vitest timeout. */
const timeboxed = <T>(fn: () => T) => Promise.race([new Promise<T>((res, rej) => setTimeout(() => { try { res(fn()); } catch (e) { rej(e); } }, 0)), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('HANG >10s')), 10000))]);

describe('boards of 0..8 cards', () => {
  test('web validation accepts only 5 cards, with a code and no throw', () => {
    for (let n = 0; n <= 8; n++) {
      const r = normalizeBoard(board(n));
      expect(r.ok, `n=${n}`).toBe(n === 5);
      if (!r.ok) expect(r.err).toBe('board.count');
    }
  });
  for (let n = 0; n <= 8; n++) {
    test(`engine (same Solver calls as the worker), ${n} cards: errors or finishes, never hangs`, async () => {
      let solver;
      try {
        solver = await timeboxed(() => { const s = new Solver(cfg(board(n), n)); if (n === 4 || n === 5) s.step(1); return s; });
      } catch (e) {
        expect(String(e instanceof Error ? e.message : e)).not.toMatch(/HANG/);
        const msg = String(e instanceof Error ? e.message : e);
        // valid lengths may only fail cleanly on the memory budget (a flop tree here is ~1.8 GB); invalid lengths fail with a board error
        if ([3, 4, 5].includes(n)) expect(msg, `valid board ${n} must not error: ${msg}`).toMatch(/budget/);
        else expect(msg).toMatch(/board cards/);
        return;
      }
      expect([3, 4, 5].includes(n), `invalid board of ${n} cards was accepted`).toBe(true);
      solver.free();
    }, 20000);
  }
});
