// E2E-ONLY (vite --mode e2e): serves the SYNTHETIC test fixture through /packs/preflop3/index.json at 20/18/16 bb.
// Never part of the production build; the output dir (dist-e2e) is git-ignored and never deployed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../src/preflop3/fixtures/SYNTHETIC-TEST-ONLY.test-fixture.pack.json', import.meta.url));

/** Derives the 18/16 bb variants from the 20 bb fixture by shifting every stack (and the all-in size). */
export function fixtureAtStack(fx, stack) {
  const p = structuredClone(fx);
  const d = fx.meta.stacksBb.BTN - stack;
  const shift = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v - d]));
  p.meta.packId = fx.meta.packId.replace('20bb', `${stack}bb`);
  p.meta.stacksBb = shift(fx.meta.stacksBb);
  for (const n of p.nodes) {
    n.stacksBb = shift(n.stacksBb);
    for (const a of n.actions) if (a.kind === 'allin') a.toBb -= d;
  }
  return p;
}
/** 16 bb only: n1 folds are rare (0.05 < 0.10 threshold) but cost almost no EV, so answering FOLD there is the "close" tier. */
export function withCloseTier(p) {
  const n = p.nodes.find((x) => x.id === 'n1');
  n.freq = n.freq.map(() => [0.05, 0.35, 0.6]);
  n.ev = n.ev.map(() => [0.14, -0.2, 0.15]);
  return p;
}
export const E2E_STACKS = [20, 18, 16];
export function e2eFiles() {
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const files = Object.fromEntries(E2E_STACKS.map((s) => [`${s}.json`, JSON.stringify(s === 16 ? withCloseTier(fixtureAtStack(fx, s)) : fixtureAtStack(fx, s))]));
  files['index.json'] = JSON.stringify({ packs: E2E_STACKS.map((s) => `${s}.json`) });
  return files;
}
export function e2ePacksPlugin() {
  return {
    name: 'e2e-preflop3-packs',
    generateBundle() {
      for (const [name, source] of Object.entries(e2eFiles())) this.emitFile({ type: 'asset', fileName: `packs/preflop3/${name}`, source });
    },
  };
}
