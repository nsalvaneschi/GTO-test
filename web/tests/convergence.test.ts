// @ts-nocheck  (uses node fs; web has no @types/node)
// Measurement only (not part of the normal suite): MEASURE=1 npx vitest run tests/convergence.test.ts
import { test } from 'vitest';
import { env } from 'node:process';
import { readFileSync, appendFileSync } from 'node:fs';
import { randomBoard } from '../src/drill';
import { parseRange, presets } from '../src/ranges';
import init, { Solver } from '../src/wasm/gto_wasm.js';

const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const CP = [100, 200, 300, 600];
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];

function measure(name: string, n: number, mk: (board: string, o: string, i: string) => object, len: number) {
  test.skipIf(!env.MEASURE)(name, async () => {
    await init({ module_or_path: readFileSync(new URL('../src/wasm/gto_wasm_bg.wasm', import.meta.url)) });
    const rng = lcg(12345), ids = Object.keys(presets);
    const e: number[][] = CP.map(() => []), t: number[][] = CP.map(() => []);
    for (let k = 0; k < n; k++) {
      const board = randomBoard(rng, undefined, len), o = ids[k % ids.length], i = ids[Math.floor(k / ids.length) % ids.length];
      const t0 = Date.now(); const s = new Solver(JSON.stringify(mk(board, o, i))); let done = 0;
      CP.forEach((c, j) => { const x = s.step(c - done); done = c; e[j].push(x); t[j].push((Date.now() - t0) / 1000); });
      s.free();
    }
    const rows = CP.map((c, j) => `${c}it expl%pot median ${q(e[j], .5).toFixed(3)} p90 ${q(e[j], .9).toFixed(3)} max ${Math.max(...e[j]).toFixed(3)} | s median ${q(t[j], .5).toFixed(1)} p90 ${q(t[j], .9).toFixed(1)} max ${Math.max(...t[j]).toFixed(1)}`);
    appendFileSync(env.MEASURE!, `${name} N=${n}\n` + rows.join('\n') + '\n');
  }, 3_600_000);
}
const rg = (o: string, i: string) => [parseRange(presets[o]), parseRange(presets[i])];
measure('turn drill', 30, (board, o, i) => ({ board, ranges: rg(o, i), budget_mb: 1024,
  streets: [{ pot: 10, stack: 50, sizes: [0.5, 1], raise_cap: 1 }, { pot: 10, stack: 50, sizes: [0.5], raise_cap: 1 }] }), 4);
measure('hh river', 20, (board, o, i) => ({ board, ranges: rg(o, i), budget_mb: 1024,
  streets: [{ pot: 10, stack: 50, sizes: [0.33, 0.5, 0.75, 1], raise_cap: 2 }] }), 5);
