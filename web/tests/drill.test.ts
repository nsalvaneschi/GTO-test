import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { combos, comboName, evLossPct, freqsFor, H, isCorrect, randomBoard, sampleHand, spotId } from '../src/drill';
import { parseRange, presets } from '../src/ranges';
import init, { Solver } from '../src/wasm/gto_wasm.js';

const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test('sampleHand returns only combos with positive weight, roughly by weight', () => {
  const range = new Float32Array(H);
  range[10] = 1; range[500] = 3; range[1000] = 0;
  const rng = lcg(7), cnt: Record<number, number> = {};
  for (let i = 0; i < 4000; i++) { const h = sampleHand(range, rng); cnt[h] = (cnt[h] ?? 0) + 1; }
  expect(Object.keys(cnt).sort()).toEqual(['10', '500']);
  expect(cnt[500] / cnt[10]).toBeGreaterThan(2.4);
  expect(cnt[500] / cnt[10]).toBeLessThan(3.8);
  expect(() => sampleHand(new Float32Array(H))).toThrow();
});

test('evLossPct = (best - chosen) / oppMass / pot in percent', () => {
  const ev = new Float32Array(3 * H), mass = new Float32Array(H).fill(2);
  ev[0 * H + 5] = 4; ev[1 * H + 5] = 10; ev[2 * H + 5] = 6;
  expect(evLossPct(ev, mass, 3, 5, 1, 10)).toBe(0);
  expect(evLossPct(ev, mass, 3, 5, 0, 10)).toBeCloseTo(30);
  expect(evLossPct(ev, mass, 3, 5, 2, 10)).toBeCloseTo(20);
});

test('freqs, correctness, ids, boards', () => {
  const s = new Float32Array(2 * H); s[7] = 0.95; s[H + 7] = 0.05;
  expect(freqsFor(s, 2, 7)).toEqual([expect.closeTo(0.95), expect.closeTo(0.05)]);
  expect(isCorrect([0.95, 0.05], 1)).toBe(false);
  expect(isCorrect([0.9, 0.1], 1)).toBe(true);
  expect(spotId('As Kd 7c 4h 2s', 'mixed', 'wide')).toMatch(/^[A-Za-z0-9_.:/-]{1,100}$/);
  expect(comboName(combos.findIndex(([a, b]) => a === 51 && b === 47 - 0 || (a === 47 && b === 51)))).toBe('AsKs');
  for (let i = 0; i < 50; i++) expect(new Set(randomBoard(Math.random).split(' ')).size).toBe(5);
});

test('real engine: dealt hand is in range, per-action EVs are consistent with the strategy and node EV', async () => {
  await init({ module_or_path: readFileSync(new URL('../src/wasm/gto_wasm_bg.wasm', import.meta.url)) });
  const s = new Solver(JSON.stringify({ board: 'As Kd 7c 4h 2s', ranges: [parseRange(presets.mixed), parseRange(presets.mixed)],
    streets: [{ pot: 10, stack: 50, sizes: [0.5, 1], raise_cap: 2 }], budget_mb: 1024 }));
  s.step(60);
  const v = JSON.parse(s.query('[]'));
  const rng = lcg(3);
  for (let i = 0; i < 20; i++) {
    const h = sampleHand(v.range, rng);
    expect(v.range[h]).toBeGreaterThan(0);
    const [a, b] = combos[h];
    expect(['As', 'Kd', '7c', '4h', '2s'].some((c) => comboName(h).includes(c))).toBe(false);
    expect(a).not.toBe(b);
    const f = freqsFor(v.strategy, v.n, h);
    expect(f.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 4);
    const mix = f.reduce((acc, p, k) => acc + p * v.action_ev[k * H + h], 0);
    expect(mix).toBeCloseTo(v.ev[h], 2);
    expect(v.opp_mass[h]).toBeGreaterThan(0);
    const losses = f.map((_, k) => evLossPct(v.action_ev, v.opp_mass, v.n, h, k, 10));
    expect(Math.min(...losses)).toBe(0);
  }
});
