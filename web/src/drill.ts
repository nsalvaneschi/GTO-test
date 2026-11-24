// Pure drill logic (no DOM) so it can be unit-tested.
export const H = 1326;
export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const combos: [number, number][] = [];
for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) combos.push([a, b]);

export const cardName = (c: number) => RANKS[c >> 2] + SUITS[c & 3];
/** Combo index -> "AsKd" (higher rank first). */
export function comboName(h: number): string {
  const [a, b] = combos[h];
  return (b >> 2) >= (a >> 2) ? cardName(b) + cardName(a) : cardName(a) + cardName(b);
}

export const presetBoards = ['As Kd 7c 4h 2s', 'Qh Jh 5d 5c 2s', 'Td 9d 8s 3c Ah', '7s 7d 2c Kh 9c', 'Jc 8h 4d Ts 6h', 'Ac Kc Qd 3h 9s'];

export function randomBoard(rng: () => number = Math.random, presets = presetBoards): string {
  if (rng() < 0.5) return presets[Math.floor(rng() * presets.length)];
  const deck = Array.from({ length: 52 }, (_, i) => i);
  const out: string[] = [];
  for (let i = 0; i < 5; i++) out.push(cardName(deck.splice(Math.floor(rng() * deck.length), 1)[0]));
  return out.join(' ');
}

/** Pick a combo index weighted by the acting player's root reach (`range`, length H). */
export function sampleHand(range: ArrayLike<number>, rng: () => number = Math.random): number {
  let tot = 0;
  for (let h = 0; h < H; h++) if (range[h] > 0) tot += range[h];
  if (!(tot > 0)) throw new Error('empty range');
  let x = rng() * tot, last = -1;
  for (let h = 0; h < H; h++) {
    if (!(range[h] > 0)) continue;
    last = h;
    if ((x -= range[h]) < 0) return h;
  }
  return last;
}

/** Solver frequencies of each action for combo h (strategy is action-major n*H). */
export const freqsFor = (strategy: ArrayLike<number>, n: number, h: number) =>
  Array.from({ length: n }, (_, k) => strategy[k * H + h]);

/** EV loss in % of pot: (best action EV - chosen action EV) in chips, from per-action EVs. */
export function evLossPct(actionEv: ArrayLike<number>, oppMass: ArrayLike<number>, n: number, h: number, chosen: number, pot: number): number {
  const m = oppMass[h];
  if (!(m > 0)) return 0;
  let best = -Infinity;
  for (let k = 0; k < n; k++) best = Math.max(best, actionEv[k * H + h]);
  return Math.max(0, ((best - actionEv[chosen * H + h]) / m / pot) * 100);
}

/** Same rule as the server: correct when the solver plays the chosen action >= 10% of the time. */
export const isCorrect = (freqs: number[], action: number) => freqs[action] >= 0.1;

export type NodeType = 'root' | 'after-check' | 'facing-bet' | 'facing-raise';
export interface Step { player: number; kind: 'check' | 'bet' | 'fold' | 'call' | 'raise'; size: number } // size = index into bet sizes (-1 = none)
export interface NodeLike { kind: string; player: number; n: number; strategy: ArrayLike<number>; range: ArrayLike<number> }

/** Meaning of action index i at a node (same convention as the UI: fold/call/raises when facing a bet, else check/bets). */
export function stepOf(player: number, i: number, fac: boolean): Step {
  if (fac) return i === 0 ? { player, kind: 'fold', size: -1 } : i === 1 ? { player, kind: 'call', size: -1 } : { player, kind: 'raise', size: i - 2 };
  return i === 0 ? { player, kind: 'check', size: -1 } : { player, kind: 'bet', size: i - 1 };
}
export const isFacing = (steps: Step[]) => steps.length > 0 && ['bet', 'raise'].includes(steps[steps.length - 1].kind);
export function nodeType(steps: Step[]): NodeType {
  if (!steps.length) return 'root';
  if (!isFacing(steps)) return 'after-check';
  return steps.filter((s) => s.kind === 'bet' || s.kind === 'raise').length > 1 ? 'facing-raise' : 'facing-bet';
}

/** Copy of `range` with combos that share a card with `board` (card ints) zeroed. */
export function maskBoard(range: ArrayLike<number>, board: number[]): Float64Array {
  const out = new Float64Array(H);
  for (let h = 0; h < H; h++) { const [a, b] = combos[h]; if (!board.includes(a) && !board.includes(b)) out[h] = range[h]; }
  return out;
}

export interface Sampled<V> { path: number[]; steps: Step[]; view: V; h: number }
/**
 * Random walk from the root. At each action node stop with prob `stopP` (hero acts here), else draw the next action
 * from the node player's reach-weighted average strategy. Stops early at a terminal/chance child or an empty range.
 * Hero combo is then drawn by reach at the final node, never colliding with the board.
 */
export async function samplePath<V extends NodeLike>(query: (path: number[]) => Promise<V>, board: number[],
  rng: () => number = Math.random, stopP = 1 / 3): Promise<Sampled<V>> {
  let path: number[] = [], steps: Step[] = [];
  let view = await query(path);
  for (;;) {
    const r = maskBoard(view.range, board);
    if (rng() < stopP) break;
    const mass = Array.from({ length: view.n }, (_, k) => { let m = 0; for (let h = 0; h < H; h++) m += r[h] * view.strategy[k * H + h]; return m; });
    const tot = mass.reduce((a, b) => a + b, 0);
    if (!(tot > 0)) break;
    let x = rng() * tot, a = view.n - 1;
    for (let k = 0; k < view.n; k++) if (mass[k] > 0 && (x -= mass[k]) < 0) { a = k; break; }
    const np = [...path, a], child = await query(np);
    if (child.kind !== 'action' || !(maskBoard(child.range, board).some((v) => v > 0))) break;
    steps = [...steps, stepOf(view.player, a, isFacing(steps))]; path = np; view = child;
  }
  return { path, steps, view, h: sampleHand(maskBoard(view.range, board), rng) };
}

export const spotId = (board: string, oop: string, ip: string, type: NodeType = 'root', path: number[] = []) =>
  `river:${type}:${board.replace(/\s+/g, '')}:${oop}-${ip}:${path.join('.') || 'root'}`;
