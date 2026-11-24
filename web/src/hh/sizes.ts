// Bet-size mapping between an observed river line and the engine tree (mirrors engine/river/src/tree.rs `go`).
// Rules (docs/handhistory-design.md section 3): observed sizes are merged into the standard menu when within MERGE of
// a menu size (the delta is recorded), added as their own size when within TOL, and anything farther, or a raise the
// raise cap cannot represent, is off-tree. All-in is always representable (the engine snaps targets to the stack).
export const STD_SIZES = [0.33, 0.5, 0.75, 1];
export const MERGE = 0.05; // pot fraction
export const TOL = 0.1; // pot fraction (inclusive)
export const RAISE_CAP = 2;
const EPS = 1e-9;

export interface TreeBase { pot: number; stack: number; cap: number }
export interface LineAction { player: 0 | 1; kind: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'; to: number | null }
// labels: one token per action at the node (f fold, c call, x check, a all-in, b<pct> bet, r<pct> raise), in engine order.
export interface Step { player: 0 | 1; kind: LineAction['kind']; idx: number; n: number; path: number[]; delta: number; frac: number; labels: string[] }
// close: chips each player has put in when the street closes by call or check-check (null if the line is not closed, or ends in a fold).
export type MapResult = { ok: true; sizes: number[]; steps: Step[]; close: number | null } | { ok: false; reason: 'size' | 'raise_cap' | 'line' };

/** Bet/raise targets at a node, same arithmetic as the engine (sorted, deduped, snapped to the stack). */
export function targets(b: TreeBase, sizes: number[], c: [number, number], me: number, aggr: number): number[] {
  const o = 1 - me;
  if (!(aggr < b.cap && c[o] < b.stack)) return [];
  const potNow = b.pot + c[0] + c[1], call = c[o] - c[me];
  const ts: number[] = [];
  for (const s of sizes) {
    let to = c[o] + s * (potNow + call);
    if (to >= b.stack - 1e-3) to = b.stack;
    if (to > c[o] + 1e-3 && !ts.some((x) => Math.abs(x - to) < 1e-3)) ts.push(to);
  }
  return ts.sort((x, y) => x - y);
}

type Walk = { ok: true; steps: Step[]; close: number | null } | { ok: false; reason: 'size' | 'raise_cap' | 'line' } | { ok: false; add: number };

function walk(line: LineAction[], b: TreeBase, sizes: number[]): Walk {
  let c: [number, number] = [0, 0], me = 0, aggr = 0, done = false, folded = false;
  const steps: Step[] = [], path: number[] = [];
  for (const a of line) {
    if (done || a.player !== me) return { ok: false, reason: 'line' };
    const o = 1 - me, facing = c[o] > c[me];
    const ts = targets(b, sizes, c, me, aggr);
    const n = (facing ? 2 : 1) + ts.length;
    const den0 = b.pot + c[0] + c[1] + (c[o] - c[me]);
    const labels = [...(facing ? ['f', 'c'] : ['x']), ...ts.map((t) => (t >= b.stack - 1e-3 ? 'a' : (facing ? 'r' : 'b') + Math.round(((t - c[o]) / den0) * 100)))];
    let idx = 0, delta = 0, frac = 0;
    if (a.kind === 'fold') { if (!facing) return { ok: false, reason: 'line' }; idx = 0; done = true; folded = true; }
    else if (a.kind === 'check') { if (facing) return { ok: false, reason: 'line' }; idx = 0; if (me === 1) done = true; }
    else if (a.kind === 'call') { if (!facing) return { ok: false, reason: 'line' }; idx = 1; done = true; }
    else {
      if (!ts.length) return { ok: false, reason: 'raise_cap' };
      const to = Math.min(a.to ?? 0, b.stack), potNow = b.pot + c[0] + c[1], den = potNow + (c[o] - c[me]);
      let ti: number;
      frac = (to - c[o]) / den;
      if (a.kind === 'allin' || to >= b.stack - 1e-3) {
        if (ts[ts.length - 1] < b.stack - 1e-3) return { ok: false, add: (b.stack - c[o]) / den + 1e-6 }; // make the shove representable
        ti = ts.length - 1;
      } else {
        const f = (to - c[o]) / den;
        ti = 0;
        ts.forEach((t, i) => { if (Math.abs(t - to) < Math.abs(ts[ti] - to)) ti = i; });
        delta = Math.abs(ts[ti] - to) / den;
        if (ts[ti] >= b.stack - 1e-3 || delta > TOL + EPS) { // nearest target is a shove or too far
          const near = Math.min(...sizes.map((s) => Math.abs(s - f)));
          if (near > TOL + EPS) return { ok: false, reason: 'size' };
          return { ok: false, add: f };
        }
        if (delta > MERGE + EPS) return { ok: false, add: f };
      }
      idx = (facing ? 2 : 1) + ti;
      steps.push({ player: a.player, kind: a.kind, idx, n, path: [...path], delta, frac, labels });
      path.push(idx); const nc: [number, number] = [c[0], c[1]]; nc[me] = ts[ti]; c = nc; aggr++; me = o;
      continue;
    }
    steps.push({ player: a.player, kind: a.kind, idx, n, path: [...path], delta, frac, labels });
    path.push(idx);
    if (a.kind === 'call') c = [Math.max(c[0], c[1]), Math.max(c[0], c[1])];
    if (a.kind === 'check') me = o;
  }
  return { ok: true, steps, close: done && !folded ? c[0] : null };
}

/** Menu (standard + needed sizes, ascending) and the per-action tree steps for an observed river line, or the off-tree reason. */
export function mapLine(line: LineAction[], b: TreeBase, std: number[] = STD_SIZES): MapResult {
  let sizes = [...std];
  for (let i = 0; i < 6; i++) {
    const w = walk(line, b, sizes);
    if (w.ok) return { ok: true, sizes, steps: w.steps, close: w.close };
    if ('reason' in w) return { ok: false, reason: w.reason };
    if (sizes.some((s) => Math.abs(s - w.add) < 1e-9)) return { ok: false, reason: 'size' };
    sizes = [...sizes, w.add].sort((x, y) => x - y);
  }
  return { ok: false, reason: 'size' };
}
