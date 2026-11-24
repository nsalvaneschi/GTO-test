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

export const spotId = (board: string, oop: string, ip: string) => `river:${board.replace(/\s+/g, '')}:${oop}-${ip}`;
