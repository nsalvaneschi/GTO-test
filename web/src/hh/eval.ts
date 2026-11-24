// 7-card hand evaluator and exact river equity. Cards are ints rank*4+suit (2c = 0), as in ../drill.ts.
import { combos } from '../drill';

const B = 13 ** 5;

/** Highest straight rank (0..12, 3 = five-high wheel) in a 13-bit rank mask, or -1. */
function straightHigh(mask: number): number {
  const ext = (mask << 1) | ((mask >> 12) & 1); // bit r+1 = rank r, bit 0 = ace-low
  for (let r = 12; r >= 3; r--) if (((ext >> (r - 3)) & 31) === 31) return r;
  return -1;
}

const topRanks = (mask: number, n: number, skip = 0): number => {
  let v = 0, got = 0;
  for (let r = 12; r >= 0 && got < n; r--) if ((mask >> r) & 1 && !((skip >> r) & 1)) { v = v * 13 + r; got++; }
  while (got++ < n) v *= 13;
  return v;
};

/** Comparable strength of the best 5 of 7 cards (higher wins; equal = tie). */
export function rank7(cs: number[]): number {
  const rc = new Array<number>(13).fill(0), sc = [0, 0, 0, 0], sm = [0, 0, 0, 0];
  let all = 0;
  for (const c of cs) { const r = c >> 2, s = c & 3; rc[r]++; sc[s]++; sm[s] |= 1 << r; all |= 1 << r; }
  for (let s = 0; s < 4; s++) if (sc[s] >= 5) {
    const sf = straightHigh(sm[s]);
    if (sf >= 0) return 8 * B + sf;
  }
  let quad = -1, trips: number[] = [], pairs: number[] = [];
  for (let r = 12; r >= 0; r--) { if (rc[r] === 4) quad = r; else if (rc[r] === 3) trips.push(r); else if (rc[r] === 2) pairs.push(r); }
  if (quad >= 0) return 7 * B + quad * 13 ** 4 + topRanks(all, 1, 1 << quad) * 13 ** 3;
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const p = trips.length > 1 ? Math.max(trips[1], pairs[0] ?? -1) : pairs[0];
    return 6 * B + trips[0] * 13 ** 4 + p * 13 ** 3;
  }
  for (let s = 0; s < 4; s++) if (sc[s] >= 5) return 5 * B + topRanks(sm[s], 5);
  const st = straightHigh(all);
  if (st >= 0) return 4 * B + st;
  if (trips.length) return 3 * B + trips[0] * 13 ** 4 + topRanks(all, 2, 1 << trips[0]) * 13 ** 2;
  if (pairs.length >= 2) return 2 * B + pairs[0] * 13 ** 4 + pairs[1] * 13 ** 3 + topRanks(all, 1, (1 << pairs[0]) | (1 << pairs[1])) * 13 ** 2;
  if (pairs.length) return 1 * B + pairs[0] * 13 ** 4 + topRanks(all, 3, 1 << pairs[0]) * 13;
  return topRanks(all, 5);
}

/** Equity (win + tie/2) of each combo in `mine` against the uniform `opp` combo list on a full 5-card board. */
export function riverEquities(board: number[], mine: number[], opp: number[]): number[] {
  const rank = new Map<number, number>();
  const rk = (h: number) => {
    let v = rank.get(h);
    if (v === undefined) { const [a, b] = combos[h]; v = rank7([...board, a, b]); rank.set(h, v); }
    return v;
  };
  return mine.map((h) => {
    const [a, b] = combos[h];
    const r = rk(h);
    let w = 0, n = 0;
    for (const o of opp) {
      const [c, d] = combos[o];
      if (c === a || c === b || d === a || d === b) continue;
      const ro = rk(o);
      w += r > ro ? 1 : r === ro ? 0.5 : 0; n++;
    }
    return n ? w / n : 0.5;
  });
}

/** Equity of each combo in `mine` against the uniform `opp` list on a 4-card board, averaged over all rivers (conflicting rivers skipped per combo). */
export function turnEquities(board: number[], mine: number[], opp: number[]): number[] {
  const sum = new Array<number>(mine.length).fill(0), cnt = new Array<number>(mine.length).fill(0);
  const has = (h: number, r: number) => combos[h][0] === r || combos[h][1] === r;
  for (let r = 0; r < 52; r++) {
    if (board.includes(r)) continue;
    const idx: number[] = [];
    mine.forEach((h, i) => { if (!has(h, r)) idx.push(i); });
    const eq = riverEquities([...board, r], idx.map((i) => mine[i]), opp.filter((h) => !has(h, r)));
    idx.forEach((i, k) => { sum[i] += eq[k]; cnt[i]++; });
  }
  return sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0.5));
}
