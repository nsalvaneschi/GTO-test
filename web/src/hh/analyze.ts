// Hand-history analysis (milestone H3): classify hero decisions, build approximate ranges, map bet sizes onto the
// engine tree, solve the river in the WASM worker and compute EV loss with the same evLossPct as the drills.
import { combos, evLossPct, freqsFor, RANKS, SUITS } from '../drill';
import { configHash, type SolveBackend, type SolveParams } from './backend';
import { riverEquities } from './eval';
import { NARROW, positions, presetFor, rangeOf, type Line, type PotType } from './ranges';
import { mapLine, RAISE_CAP, type LineAction } from './sizes';
import type { ActionKind, Hand, Site, Street } from './types';

export const ENGINE_VER = 'river-wasm-0.1';
export const SOLVE: SolveParams = { target: 0.3, chunk: 20, maxIters: 2000 };
/** Above this exploitability (% of pot) the numbers are only indicative: status approx_only. */
export const MAX_EXPL = 1;

export type Reason =
  | 'multiway' | 'preflop' | 'allin_preflop' | 'flop' | 'turn_not_yet' | 'no_hero' | 'no_hero_decision'
  | 'hero_cards_unknown' | 'no_preset' | 'range_empty' | 'off_tree' | 'bad_board' | 'solve_failed';
export type Status = 'ok' | 'off_tree' | 'unsupported' | 'approx_only';

export interface Candidate { hand: Hand; actionIndex: number; street: Street; reason: Reason | null }

const HERO_KINDS: ActionKind[] = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];

/** One entry per hero decision: analysable (reason null) or the reason code why not. Hand-level entries use actionIndex -1. */
export function classify(hand: Hand): Candidate[] {
  if (hand.hero === null) return [{ hand, actionIndex: -1, street: 'preflop', reason: 'no_hero' }];
  const out: Candidate[] = [];
  const folded = new Set<number>(); // folds on earlier streets
  let cur: Street | null = null, foldedHere: number[] = [];
  const preflopAllin = hand.actions.some((a) => a.street === 'preflop' && a.allin);
  hand.actions.forEach((a, i) => {
    if (a.street !== cur) { foldedHere.forEach((s) => folded.add(s)); foldedHere = []; cur = a.street; }
    if (a.kind === 'fold') foldedHere.push(a.seat);
    if (a.seat !== hand.hero || !HERO_KINDS.includes(a.kind)) return;
    let reason: Reason | null = null;
    if (a.street === 'preflop') reason = preflopAllin ? 'allin_preflop' : 'preflop';
    else if (a.street === 'flop') reason = 'flop';
    else if (a.street === 'turn') reason = 'turn_not_yet';
    else if (hand.seats.filter((s) => !folded.has(s.seat)).length > 2) reason = 'multiway';
    else if (!hand.hero_cards) reason = 'hero_cards_unknown';
    else if (hand.board.length !== 5) reason = 'bad_board';
    out.push({ hand, actionIndex: i, street: a.street, reason });
  });
  if (!out.length) out.push({ hand, actionIndex: -1, street: 'preflop', reason: 'no_hero_decision' });
  return out;
}

export interface Overrides { width?: number; heroRange?: string; villainRange?: string } // width: top share kept, 0..1

export interface Meta {
  kind: ActionKind; frac: number | null; heroPos: string; villainPos: string; heroOop: boolean; potType: PotType;
  top: number; bluff: number; sizes: number[]; maxDelta: number; pot: number; stack: number; combo: string;
  expl: number; iters: number; solveMs: number; cached: boolean; heroReach: number;
}
export interface DecisionResult {
  site: Site; hand_id: string; street: Street; actionIndex: number; nodePath: string; actionIdx: number;
  status: Status; reason: Reason | null; solverFreqs: number[] | null; evLoss: number | null;
  rangePreset: string; engineVer: string; meta: Meta | null;
}

const cardInt = (s: string) => RANKS.indexOf(s[0]) * 4 + SUITS.indexOf(s[1]);
const comboIdx = new Map<number, number>();
combos.forEach(([a, b], h) => comboIdx.set(a * 52 + b, h));
const idxOf = (a: number, b: number) => comboIdx.get(Math.min(a, b) * 52 + Math.max(a, b))!;
const comboOfKey = (k: string) => idxOf(cardInt(k.slice(0, 2)), cardInt(k.slice(2)));

function lineOf(hand: Hand, seat: number): Line {
  const mine = hand.actions.filter((a) => a.seat === seat && (a.street === 'flop' || a.street === 'turn'));
  return mine.some((a) => a.kind === 'bet' || a.kind === 'raise' || a.kind === 'allin') ? 'aggr' : mine.some((a) => a.kind === 'call') ? 'call' : 'check';
}

/** Keep the top `top` share of `list` by equity plus the bottom `bluff` share (of the full list) from the rest. */
export function narrow(list: number[], eq: number[], top: number, bluff: number): number[] {
  const order = list.map((h, i) => [h, eq[i]] as const).sort((a, b) => b[1] - a[1]);
  const keep = Math.ceil(top * order.length), nb = Math.round(bluff * order.length);
  const rest = order.slice(keep);
  return [...order.slice(0, keep), ...rest.slice(Math.max(0, rest.length - nb))].map((x) => x[0]);
}

export interface Spot {
  preset: string; potType: PotType; heroOop: boolean; heroPos: string; villainPos: string; top: number; bluff: number;
  ranges: [Record<string, number>, Record<string, number>]; hero: number; pot: number; stack: number; board: string; heroSeat: number;
}

/** Ranges and tree parameters for the river between hero and the one opponent, or the reason it cannot be built. */
export function buildSpot(hand: Hand, ov: Overrides = {}): Spot | Reason {
  const live = hand.seats.filter((s) => !hand.actions.some((a) => a.seat === s.seat && a.kind === 'fold' && a.street !== 'river')).map((s) => s.seat);
  if (live.length !== 2 || hand.hero === null || !live.includes(hand.hero) || !hand.hero_cards) return 'no_preset';
  const hs = hand.hero, vs = live.find((s) => s !== hs)!;
  const pre = presetFor(hand, hs, vs);
  const rv = hand.pot_by_street.find((p) => p.street === 'river');
  if (!pre || !rv) return 'no_preset';
  const board = hand.board.map(cardInt);
  const hc = hand.hero_cards.map(cardInt), heroH = idxOf(hc[0], hc[1]);
  const list = (spec: string, drop: number[]) => Object.keys(rangeOf(spec)).map(comboOfKey)
    .filter((h) => ![...board, ...drop].some((c) => combos[h][0] === c || combos[h][1] === c));
  const mine = list(ov.heroRange ?? pre.spec[hs], []);
  const theirs = list(ov.villainRange ?? pre.spec[vs], hc);
  if (!mine.length || !theirs.length) return 'range_empty';
  const nar = (self: number[], opp: number[], seat: number) => {
    const ln = NARROW[lineOf(hand, seat)], top = ov.width ?? ln.top;
    return { h: narrow(self, riverEquities(board, self, opp), top, ln.bluff), top, bluff: ln.bluff };
  };
  const nm = nar(mine, theirs, hs), nv = nar(theirs, mine, vs);
  const heroSet = new Set([...nm.h, heroH]);
  const pos = positions(hand);
  const order = hand.seats.map((s) => s.seat).sort((a, b) => a - b);
  const bi = Math.max(0, order.indexOf(hand.button));
  const oopSeat = [...order.slice(bi + 1), ...order.slice(0, bi + 1)].find((s) => s === hs || s === vs)!;
  const sparse = (hs_: Iterable<number>) => {
    const o: Record<string, number> = {};
    for (const h of [...hs_].sort((a, b) => a - b)) o[RANKS[combos[h][0] >> 2] + SUITS[combos[h][0] & 3] + RANKS[combos[h][1] >> 2] + SUITS[combos[h][1] & 3]] = 1;
    return o;
  };
  const heroRange = sparse(heroSet), vilRange = sparse(nv.h);
  const stack = Math.min(rv.stacks[hs], rv.stacks[vs]);
  const custom = (ov.heroRange || ov.villainRange ? ':custom' : '') + (ov.width !== undefined ? `:w${Math.round(ov.width * 100)}` : '');
  return {
    preset: pre.name + custom, potType: pre.potType, heroOop: oopSeat === hs, heroPos: pos[hs], villainPos: pos[vs], top: nm.top, bluff: nm.bluff,
    ranges: oopSeat === hs ? [heroRange, vilRange] : [vilRange, heroRange], hero: heroH, pot: rv.pot, stack, board: hand.board.join(' '), heroSeat: hs,
  };
}

const skipped = (c: Candidate, status: Status, reason: Reason, preset = 'none'): DecisionResult => ({
  site: c.hand.site, hand_id: c.hand.hand_id, street: c.street, actionIndex: c.actionIndex, nodePath: c.actionIndex < 0 ? 'hand' : `a${c.actionIndex}`,
  actionIdx: 0, status, reason, solverFreqs: null, evLoss: null, rangePreset: preset, engineVer: ENGINE_VER, meta: null,
});

export interface Env {
  backend: SolveBackend; overrides?: Overrides; params?: SolveParams;
  onProgress?: (expl: number, iters: number) => void; signal?: { aborted: boolean };
}

/** Analyse every hero decision of a hand. Only HU river decisions get EV; the rest carry their reason code. */
export async function analyzeHand(hand: Hand, env: Env): Promise<DecisionResult[]> {
  const cands = classify(hand);
  const spot = cands.some((c) => c.reason === null) ? buildSpot(hand, env.overrides) : null;
  const river = hand.actions.map((a, i) => ({ a, i })).filter((x) => x.a.street === 'river');
  const out: DecisionResult[] = [];
  for (const c of cands) {
    if (c.reason) { out.push(skipped(c, 'unsupported', c.reason)); continue; }
    if (env.signal?.aborted) throw new Error('cancelled');
    if (typeof spot === 'string') { out.push(skipped(c, 'unsupported', spot)); continue; }
    const s = spot!;
    const seatPlayer = (seat: number): 0 | 1 => (seat === hand.hero ? (s.heroOop ? 0 : 1) : s.heroOop ? 1 : 0);
    const upto = river.findIndex((x) => x.i === c.actionIndex);
    const line: LineAction[] = river.slice(0, upto + 1).map(({ a }) => ({ player: seatPlayer(a.seat), kind: a.kind, to: a.amount_to }));
    const map = mapLine(line, { pot: s.pot, stack: s.stack, cap: RAISE_CAP });
    if (!map.ok) { out.push(skipped(c, 'off_tree', 'off_tree', s.preset)); continue; }
    const step = map.steps[map.steps.length - 1];
    const config = JSON.stringify({ board: s.board, ranges: s.ranges, streets: [{ pot: s.pot, stack: s.stack, sizes: map.sizes, raise_cap: RAISE_CAP }], budget_mb: 1024 });
    const key = configHash(config);
    let info, view;
    try {
      info = await env.backend.solve(key, config, env.params ?? SOLVE, env.onProgress);
      view = await env.backend.query(key, step.path);
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') throw e;
      out.push(skipped(c, 'unsupported', 'solve_failed', s.preset)); continue;
    }
    if (view.kind !== 'action' || view.player !== step.player || view.n !== step.n || !view.action_ev || !view.opp_mass) {
      out.push(skipped(c, 'off_tree', 'off_tree', s.preset)); continue;
    }
    const freqs = freqsFor(view.strategy, view.n, s.hero);
    const evLoss = evLossPct(view.action_ev, view.opp_mass, view.n, s.hero, step.idx, s.pot);
    out.push({
      site: hand.site, hand_id: hand.hand_id, street: 'river', actionIndex: c.actionIndex, nodePath: step.path.join('.') || 'root', actionIdx: step.idx,
      status: info.expl > MAX_EXPL ? 'approx_only' : 'ok', reason: null, solverFreqs: freqs, evLoss, rangePreset: s.preset, engineVer: ENGINE_VER,
      meta: { kind: step.kind, frac: step.kind === 'bet' || step.kind === 'raise' || step.kind === 'allin' ? step.frac : null,
        heroPos: s.heroPos, villainPos: s.villainPos, heroOop: s.heroOop, potType: s.potType, top: s.top, bluff: s.bluff, sizes: map.sizes,
        maxDelta: Math.max(0, ...map.steps.map((x) => x.delta)), pot: s.pot, stack: s.stack, combo: hand.hero_cards!.join(''),
        expl: info.expl, iters: info.iters, solveMs: info.ms, cached: info.cached, heroReach: view.range[s.hero] ?? 0 },
    });
  }
  return out;
}
