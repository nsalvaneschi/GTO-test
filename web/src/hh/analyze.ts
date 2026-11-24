// Hand-history analysis (H3 river, H4 turn): classify hero decisions, build approximate ranges, map bet sizes onto the
// engine tree, solve in the WASM worker and compute EV loss with the same evLossPct as the drills. Heads-up turn hands
// are solved once as a turn+river tree and the hero's turn and river decisions all read that solve.
import { combos, evLossPct, freqsFor, RANKS, SUITS } from '../drill';
import { configHash, type NodeView, type SolveBackend, type SolveParams } from './backend';
import { riverEquities, turnEquities } from './eval';
import { NARROW, positions, presetFor, rangeOf, type Line, type PotType } from './ranges';
import { mapLine, RAISE_CAP, STD_SIZES, type LineAction, type MapResult } from './sizes';
import type { ActionKind, Hand, Site, Street } from './types';

export const ENGINE_VER = 'hh-wasm-0.2';
export const SOLVE: SolveParams = { target: 0.3, chunk: 20, maxIters: 2000 };
/** Turn+river solve: no re-raise in the tree (cap 1, like the turn drill) keeps the standard menu inside the 1 GB budget; 20 s wall budget. */
export const TURN_CAP = 1;
export const TURN_SOLVE: SolveParams = { target: 0.3, chunk: 10, maxIters: 300, maxMs: 20000 };
/** River menu inside the turn+river tree. Measured on a 226 x 331 combo turn spot: 4 river sizes 20.5 s, 2 sizes 9 s (turn menu STD in both).
 *  River decisions with other sizes are answered by the cheap river-only solve instead. */
export const RIVER_IN_TURN = [0.5, 1];
/** Menu used when the full turn solve is too slow or too big: turn 50%/100%, river 50% (the turn drill menu). */
export const SMALL_MENU: [number[], number[]] = [[0.5, 1], [0.5]];
/** Config hashes whose full-menu solve timed out or did not fit: later hands skip straight to the small menu. */
export const slowKeys = new Set<string>();
/** Above this exploitability (% of pot) the numbers are only indicative: status approx_only. */
export const MAX_EXPL = 1;

export type Reason =
  | 'multiway' | 'preflop' | 'allin_preflop' | 'flop' | 'turn_small_menu' | 'no_hero' | 'no_hero_decision'
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
    else if (hand.seats.filter((s) => !folded.has(s.seat)).length > 2) reason = 'multiway';
    else if (!hand.hero_cards) reason = 'hero_cards_unknown';
    else if (a.street === 'turn' ? hand.board.length < 4 : hand.board.length !== 5) reason = 'bad_board';
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
  /** Which tree answered: a turn+river solve ('turn') or a river-only solve ('river'); tier 'small' = reduced menu. */
  solve: 'turn' | 'river'; tier: 'full' | 'small';
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

/** Line of `seat` on the given earlier streets: bet/raise beats call beats check. */
export function lineOf(hand: Hand, seat: number, streets: Street[] = ['flop', 'turn']): Line {
  const mine = hand.actions.filter((a) => a.seat === seat && streets.includes(a.street));
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
  ranges: [Record<string, number>, Record<string, number>]; hero: number; pot: number; stack: number; board: string; heroSeat: number; vilSeat: number;
}

/** Ranges and tree parameters for the turn or river between hero and the one opponent, or the reason it cannot be built. */
export function buildSpot(hand: Hand, ov: Overrides = {}, street: 'turn' | 'river' = 'river'): Spot | Reason {
  const later: Street[] = street === 'turn' ? ['turn', 'river'] : ['river'], earlier: Street[] = street === 'turn' ? ['flop'] : ['flop', 'turn'];
  const live = hand.seats.filter((s) => !hand.actions.some((a) => a.seat === s.seat && a.kind === 'fold' && !later.includes(a.street))).map((s) => s.seat);
  if (live.length !== 2 || hand.hero === null || !live.includes(hand.hero) || !hand.hero_cards) return 'no_preset';
  const hs = hand.hero, vs = live.find((s) => s !== hs)!;
  const pre = presetFor(hand, hs, vs);
  const st = hand.pot_by_street.find((p) => p.street === street);
  const bl = street === 'turn' ? 4 : 5;
  if (!pre || !st || hand.board.length < bl) return 'no_preset';
  const boardStr = hand.board.slice(0, bl);
  const board = boardStr.map(cardInt);
  const equities = street === 'turn' ? turnEquities : riverEquities;
  const hc = hand.hero_cards.map(cardInt), heroH = idxOf(hc[0], hc[1]);
  const list = (spec: string, drop: number[]) => Object.keys(rangeOf(spec)).map(comboOfKey)
    .filter((h) => ![...board, ...drop].some((c) => combos[h][0] === c || combos[h][1] === c));
  const mine = list(ov.heroRange ?? pre.spec[hs], []);
  const theirs = list(ov.villainRange ?? pre.spec[vs], hc);
  if (!mine.length || !theirs.length) return 'range_empty';
  const nar = (self: number[], opp: number[], seat: number) => {
    const ln = NARROW[lineOf(hand, seat, earlier)], top = ov.width ?? ln.top;
    return { h: narrow(self, equities(board, self, opp), top, ln.bluff), top, bluff: ln.bluff };
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
  const stack = Math.min(st.stacks[hs], st.stacks[vs]);
  const custom = (ov.heroRange || ov.villainRange ? ':custom' : '') + (ov.width !== undefined ? `:w${Math.round(ov.width * 100)}` : '');
  return {
    preset: pre.name + custom, potType: pre.potType, heroOop: oopSeat === hs, heroPos: pos[hs], villainPos: pos[vs], top: nm.top, bluff: nm.bluff,
    ranges: oopSeat === hs ? [heroRange, vilRange] : [vilRange, heroRange], hero: heroH, pot: st.pot, stack, board: boardStr.join(' '), heroSeat: hs, vilSeat: vs,
  };
}

const skipped = (c: Candidate, status: Status, reason: Reason, preset = 'none'): DecisionResult => ({
  site: c.hand.site, hand_id: c.hand.hand_id, street: c.street, actionIndex: c.actionIndex, nodePath: c.actionIndex < 0 ? 'hand' : `a${c.actionIndex}`,
  actionIdx: 0, status, reason, solverFreqs: null, evLoss: null, rangePreset: preset, engineVer: ENGINE_VER, meta: null,
});

export interface Env {
  backend: SolveBackend; overrides?: Overrides; params?: SolveParams; turnParams?: SolveParams; skipTurn?: boolean; // skipTurn: river decisions are always solved alone (H3 path)
 
  onProgress?: (expl: number, iters: number) => void; signal?: { aborted: boolean };
}

type Tier = 'full' | 'small';
const isSlow = (e: unknown) => /^timeout$|budget/.test(e instanceof Error ? e.message : String(e));
interface StepLike { path: number[]; idx: number; n: number; player: 0 | 1; kind: ActionKind; frac: number; labels: string[] }
interface Plan { step: StepLike; prefix: number[]; pot: number; sizes: number[]; delta: number; tSizes: number[]; rSizes: number[] }

/**
 * Analyse every hero decision of a hand. Heads-up turn decisions get EV from a turn+river solve; river decisions of a hand
 * that was heads-up on the turn read the same solve (same config, so a cache hit). Everything else is river-only (H3) or
 * carries its reason code.
 */
export async function analyzeHand(hand: Hand, env: Env): Promise<DecisionResult[]> {
  const cands = classify(hand);
  const byAction = new Map<number, DecisionResult>();
  const acts = (street: Street) => hand.actions.map((a, i) => ({ a, i })).filter((x) => x.a.street === street);
  const onTurn = acts('turn'), onRiver = acts('river');
  const tspot = cands.some((c) => !c.reason) && !env.skipTurn ? buildSpot(hand, env.overrides, 'turn') : 'no_preset' as Reason;
  const seatPlayer = (s: Spot) => (seat: number): 0 | 1 => (seat === hand.hero ? (s.heroOop ? 0 : 1) : s.heroOop ? 1 : 0);

  /** Menus, tree path and pot of one decision in the turn+river tree for a tier; null = off-tree, 'none' = the turn solve cannot answer it. */
  function plan(s: Spot, c: Candidate, tier: Tier): Plan | null | 'none' {
    const [stdT, stdR] = tier === 'full' ? [STD_SIZES, RIVER_IN_TURN] : SMALL_MENU;
    const seatP = seatPlayer(s), base = { pot: s.pot, stack: s.stack, cap: TURN_CAP };
    const line = (list: typeof onTurn): LineAction[] => list.map(({ a }) => ({ player: seatP(a.seat), kind: a.kind, to: a.amount_to }));
    const fullT = mapLine(line(onTurn), base, stdT);
    // The whole river line, rescaled to the tree's river pot (it differs from the real one by the size-merge delta).
    let fullR: MapResult | null = null, potR = 0;
    const rv = hand.pot_by_street.find((p) => p.street === 'river');
    if (fullT.ok && fullT.close !== null && onRiver.length && rv && tier === 'full') {
      potR = s.pot + 2 * fullT.close;
      const stackR = s.stack - fullT.close, ratio = potR / rv.pot, real = Math.min(rv.stacks[s.heroSeat], rv.stacks[s.vilSeat]);
      fullR = mapLine(onRiver.map(({ a }) => ({ player: seatP(a.seat), kind: a.kind,
        to: a.amount_to === null ? null : a.amount_to >= real - 1e-3 ? stackR : Math.min(stackR, a.amount_to * ratio) })), { pot: potR, stack: stackR, cap: TURN_CAP }, stdR);
    }
    const rSizes = fullR && fullR.ok ? fullR.sizes : stdR;
    if (c.street === 'turn') {
      const pos = onTurn.findIndex((x) => x.i === c.actionIndex);
      const m = fullT.ok ? fullT : mapLine(line(onTurn.slice(0, pos + 1)), base, stdT);
      if (!m.ok) return null;
      return { step: m.steps[pos], prefix: [], pot: s.pot, sizes: m.sizes, delta: Math.max(0, ...m.steps.map((x) => x.delta)), tSizes: m.sizes, rSizes };
    }
    if (!fullT.ok || !fullR || !fullR.ok) return 'none';
    const pos = onRiver.findIndex((x) => x.i === c.actionIndex);
    return { step: fullR.steps[pos], prefix: [...fullT.steps.map((x) => x.idx), cardInt(hand.board[4])], pot: potR, sizes: fullR.sizes,
      delta: Math.max(0, ...fullT.steps.map((x) => x.delta), ...fullR.steps.map((x) => x.delta)), tSizes: fullT.sizes, rSizes: fullR.sizes };
  }

  function finish(s: Spot, c: Candidate, step: StepLike, prefix: number[], pot: number, sizes: number[], maxDelta: number,
    info: { cached: boolean; expl: number; iters: number; ms: number }, view: NodeView, solve: 'turn' | 'river', tier: Tier): DecisionResult {
    if (view.kind !== 'action' || view.player !== step.player || view.n !== step.n || !view.action_ev || !view.opp_mass) return skipped(c, 'off_tree', 'off_tree', s.preset);
    const small = tier === 'small';
    return {
      site: hand.site, hand_id: hand.hand_id, street: c.street, actionIndex: c.actionIndex,
      nodePath: `a${c.actionIndex}/${[...prefix, ...step.path].join('.') || 'root'}/${step.labels.join('.')}`, actionIdx: step.idx,
      status: small || info.expl > MAX_EXPL ? 'approx_only' : 'ok', reason: small ? 'turn_small_menu' : null,
      solverFreqs: freqsFor(view.strategy, view.n, s.hero), evLoss: evLossPct(view.action_ev, view.opp_mass, view.n, s.hero, step.idx, pot),
      rangePreset: s.preset, engineVer: ENGINE_VER,
      meta: { kind: step.kind, frac: step.kind === 'bet' || step.kind === 'raise' || step.kind === 'allin' ? step.frac : null,
        heroPos: s.heroPos, villainPos: s.villainPos, heroOop: s.heroOop, potType: s.potType, top: s.top, bluff: s.bluff, sizes, maxDelta, pot, stack: s.stack,
        combo: hand.hero_cards!.join(''), expl: info.expl, iters: info.iters, solveMs: info.ms, cached: info.cached, heroReach: view.range[s.hero] ?? 0, solve, tier },
    };
  }

  async function viaTurn(s: Spot, c: Candidate): Promise<DecisionResult | 'none'> {
    let tier: Tier = 'full';
    for (;;) {
      const p = plan(s, c, tier);
      if (p === 'none') return 'none';
      if (!p) return skipped(c, 'off_tree', 'off_tree', s.preset);
      const config = JSON.stringify({ board: s.board, ranges: s.ranges, iso: false, budget_mb: 1024,
        streets: [{ pot: s.pot, stack: s.stack, sizes: p.tSizes, raise_cap: TURN_CAP }, { pot: s.pot, stack: s.stack, sizes: p.rSizes, raise_cap: TURN_CAP }] });
      const key = configHash(config);
      if (env.signal?.aborted) throw new Error('cancelled');
      try {
        if (tier === 'full' && slowKeys.has(key)) throw new Error('timeout');
        const tp = env.turnParams ?? TURN_SOLVE; // the reduced menu is cheap, so only the full menu is time-boxed
        const info = await env.backend.solve(key, config, tier === 'small' ? { ...tp, maxMs: undefined } : tp, env.onProgress);
        const view = await env.backend.query(key, [...p.prefix, ...p.step.path]);
        return finish(s, c, p.step, p.prefix, p.pot, p.sizes, p.delta, info, view, 'turn', tier);
      } catch (e) {
        if (e instanceof Error && e.message === 'cancelled') throw e;
        if (!isSlow(e)) return skipped(c, 'unsupported', 'solve_failed', s.preset);
        if (tier === 'small') return skipped(c, 'unsupported', 'solve_failed', s.preset);
        slowKeys.add(key); tier = 'small';
      }
    }
  }

  // River-only (H3) path: river decisions without a usable turn solve.
  let rspot: Spot | Reason | null = null;
  async function riverOnly(c: Candidate): Promise<DecisionResult> {
    rspot ??= buildSpot(hand, env.overrides, 'river');
    if (typeof rspot === 'string') return skipped(c, 'unsupported', rspot);
    const s = rspot;
    const upto = onRiver.findIndex((x) => x.i === c.actionIndex);
    const line: LineAction[] = onRiver.slice(0, upto + 1).map(({ a }) => ({ player: seatPlayer(s)(a.seat), kind: a.kind, to: a.amount_to }));
    const map = mapLine(line, { pot: s.pot, stack: s.stack, cap: RAISE_CAP });
    if (!map.ok) return skipped(c, 'off_tree', 'off_tree', s.preset);
    const step = map.steps[map.steps.length - 1];
    const config = JSON.stringify({ board: s.board, ranges: s.ranges, streets: [{ pot: s.pot, stack: s.stack, sizes: map.sizes, raise_cap: RAISE_CAP }], budget_mb: 1024 });
    const key = configHash(config);
    try {
      const info = await env.backend.solve(key, config, env.params ?? SOLVE, env.onProgress);
      const view = await env.backend.query(key, step.path);
      return finish(s, c, step, [], s.pot, map.sizes, Math.max(0, ...map.steps.map((x) => x.delta)), info, view, 'river', 'full');
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') throw e;
      return skipped(c, 'unsupported', 'solve_failed', s.preset);
    }
  }

  for (const c of cands) {
    if (c.reason) { byAction.set(c.actionIndex, skipped(c, 'unsupported', c.reason)); continue; }
    if (env.signal?.aborted) throw new Error('cancelled');
    let r: DecisionResult | 'none' = 'none';
    if (typeof tspot !== 'string') r = await viaTurn(tspot, c);
    else if (c.street === 'turn') { byAction.set(c.actionIndex, skipped(c, 'unsupported', tspot)); continue; }
    byAction.set(c.actionIndex, r === 'none' ? await riverOnly(c) : r);
  }
  return cands.map((c) => byAction.get(c.actionIndex)!);
}
