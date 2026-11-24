import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { combos, comboName, evLossPct, freqsFor, H, isCorrect, randomBoard, sampleHand, spotId, samplePath, nodeType, stepOf } from '../src/drill';
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

// synthetic 2-level tree: root (OOP: check 25% / bet 75% for hand 0, always bet for hand 1), then IP node reach depends on that
const fake = (path: number[]) => {
  const range = new Float32Array(H), strategy = new Float32Array(2 * H);
  if (path.length === 0) {
    range[0] = 1; range[1] = 1; range[2] = 1;      // combo 2 shares a card with the board below
    strategy[0] = 0.25; strategy[H] = 0.75; strategy[1] = 0; strategy[H + 1] = 1; strategy[2] = 0.5; strategy[H + 2] = 0.5;
    return Promise.resolve({ kind: 'action', player: 0, n: 2, strategy, range });
  }
  if (path.length === 1) {
    const r = path[0] === 0 ? [0.25 * 1, 0, 0] : [0.75, 1, 0];
    r.forEach((x, h) => (range[h + 10] = x)); strategy[10] = strategy[H + 10] = 0.5;
    strategy[H + 11] = 1; range[0] = 0;
    return Promise.resolve({ kind: 'action', player: 1, n: 2, strategy, range });
  }
  return Promise.resolve({ kind: 'showdown', player: 0, n: 0, strategy, range });
};

test('samplePath: reach-weighted, deterministic, never board-colliding or zero-reach', async () => {
  const board = [combos[2][1]]; // blocks combo 2
  const run = async (seed: number) => { const rng = lcg(seed), out: string[] = []; for (let i = 0; i < 3000; i++) { const s = await samplePath(fake, board, rng, 0.4); out.push(`${s.path}|${s.h}`); } return out; };
  const a = await run(5);
  expect(await run(5)).toEqual(a);
  const cnt: Record<string, number> = {};
  for (const x of a) cnt[x] = (cnt[x] ?? 0) + 1;
  for (const k of Object.keys(cnt)) {
    const [p, h] = k.split('|'); const hh = +h;
    expect(combos[hh].some((c) => board.includes(c))).toBe(false);
    if (p === '0') expect(hh).toBe(10);          // only combo 10 has reach after check
    if (p === '1') expect([10, 11]).toContain(hh);
    if (p === '') expect([0, 1]).toContain(hh);
  }
  expect(Object.keys(cnt).some((k) => k.startsWith('1|'))).toBe(true);
  // after bet, hand 10 (reach .75) vs 11 (reach 1) by weight
  expect(cnt['1|11'] / cnt['1|10']).toBeGreaterThan(1.1);
  expect(cnt['1|11'] / cnt['1|10']).toBeLessThan(1.6);
  expect(a.some((x) => x.startsWith('|'))).toBe(true); // root still sampled
  expect(nodeType([stepOf(0, 1, false)])).toBe('facing-bet');
  expect(nodeType([stepOf(0, 1, false), stepOf(1, 2, true)])).toBe('facing-raise');
  expect(nodeType([stepOf(0, 0, false)])).toBe('after-check');
  expect(spotId('As Kd 7c 4h 2s', 'a', 'b', 'facing-bet', [1])).toBe('river:facing-bet:AsKd7c4h2s:a-b:1');
});

test('real engine: sampled non-root nodes are valid and consistent', async () => {
  await init({ module_or_path: readFileSync(new URL('../src/wasm/gto_wasm_bg.wasm', import.meta.url)) });
  const s = new Solver(JSON.stringify({ board: 'As Kd 7c 4h 2s', ranges: [parseRange(presets.mixed), parseRange(presets.mixed)],
    streets: [{ pot: 10, stack: 50, sizes: [0.5, 1], raise_cap: 2 }], budget_mb: 1024 }));
  s.step(60);
  const q = async (p: number[]) => JSON.parse(s.query(JSON.stringify(p)));
  const board = [51, 46, 21, 14, 3]; // As Kd 7c 4h 2s
  const rng = lcg(11), types = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const r = await samplePath(q, board, rng, 0.3);
    const v = r.view;
    types.add(nodeType(r.steps));
    expect(v.kind).toBe('action');
    expect(v.range[r.h]).toBeGreaterThan(0);
    expect(combos[r.h].some((c) => board.includes(c))).toBe(false);
    const f = freqsFor(v.strategy, v.n, r.h);
    expect(f.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 4);
    expect(f.reduce((acc, p, k) => acc + p * v.action_ev[k * H + r.h], 0)).toBeCloseTo(v.ev[r.h], 2);
    expect(Math.min(...f.map((_, k) => evLossPct(v.action_ev, v.opp_mass, v.n, r.h, k, 10)))).toBe(0);
  }
  console.log('node types sampled:', [...types]);
  expect(types.size).toBeGreaterThan(1);
});

test('turn: 4-card boards and turn spot ids', () => {
  for (let i = 0; i < 50; i++) expect(new Set(randomBoard(Math.random, undefined, 4).split(' ')).size).toBe(4);
  expect(spotId('As Kd 7c 4h', 'a', 'b', 'root', [], 'turn')).toBe('turn:root:AsKd7c4h:a-b:root');
});

test('real engine turn tree: sampler stops at chance nodes, never passes through the river card, masks board', async () => {
  await init({ module_or_path: readFileSync(new URL('../src/wasm/gto_wasm_bg.wasm', import.meta.url)) });
  const s = new Solver(JSON.stringify({ board: 'As Kd 7c 4h', ranges: [parseRange(presets.mixed), parseRange(presets.mixed)],
    streets: [{ pot: 10, stack: 50, sizes: [0.5, 1], raise_cap: 1 }, { pot: 10, stack: 50, sizes: [0.5], raise_cap: 1 }], budget_mb: 1024 }));
  s.step(30);
  const kinds: string[] = [];
  const q = async (p: number[]) => { const v = JSON.parse(s.query(JSON.stringify(p))); kinds.push(v.kind); return v; };
  expect(JSON.parse(s.query('[0,0]')).kind).toBe('chance'); // check-check deals the river
  const board = [51, 46, 21, 14];
  const rng = lcg(21), types = new Set<string>();
  for (let i = 0; i < 80; i++) {
    const r = await samplePath(q, board, rng, 0.3);
    types.add(nodeType(r.steps));
    expect(r.view.kind).toBe('action');
    expect(r.path.length).toBe(r.steps.length); // only action indices: no card id, so no river street
    // every prefix of the path is an action node (a chance node would mean the walk crossed into the river)
    for (let d = 0; d < r.path.length; d++) expect(JSON.parse(s.query(JSON.stringify(r.path.slice(0, d + 1)))).kind === 'action' || d === r.path.length - 1).toBe(true);
    expect(combos[r.h].some((c) => board.includes(c))).toBe(false);
    expect(r.view.range[r.h]).toBeGreaterThan(0);
    const losses = freqsFor(r.view.strategy, r.view.n, r.h).map((_, k) => evLossPct(r.view.action_ev, r.view.opp_mass, r.view.n, r.h, k, 10));
    expect(Math.min(...losses)).toBe(0);
    expect(Math.max(...losses)).toBeLessThan(700); // chips per unit deal (opp_mass counts river deals): bounded by pot+stack = 60 chips
  }
  expect(kinds).toContain('chance'); // walks did hit chance nodes and stopped there
  expect(types.size).toBeGreaterThan(1);
}, 60000);
