// Pure trainer logic (no DOM). Spots, sampling, button mapping, scoring, explanation params.
// Reach/combo choice: class weights use 6/4/12 combos; card removal BETWEEN players is IGNORED
// (each player's range is treated as independent). Node reach = product over the three players of
// (sum_class combos*reachClass / 1326); a player's class reach = product of that player's own
// earlier action frequencies on the path (null row = 0). Hero concrete suits are uniform over the class.
import { CLASSES, POSITIONS, comboCount, replay, type Pack, type PackAction, type PackNode, type Position, type Stacks } from './types';

export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMBOS = CLASSES.map(comboCount);
const TOTAL_COMBOS = 1326;
const massOf = (r: number[]) => r.reduce((s, x, i) => s + x * COMBOS[i], 0) / TOTAL_COMBOS;

export interface Spot {
  nodeId: string;
  hero: Position;
  /** Hero class reach at this node (own earlier actions x node row non-null); 169 entries. */
  heroReach: number[];
  /** Probability of reaching the node = product of the 3 players' range masses. */
  weight: number;
}

export function buildSpots(pack: Pack): Spot[] {
  const byId = new Map(pack.nodes.map((n) => [n.id, n]));
  const spots: Spot[] = [];
  const ones = () => new Array<number>(169).fill(1);
  const walk = (n: PackNode, reach: Record<Position, number[]>) => {
    const hero = reach[n.actor];
    const heroReach = hero.map((r, i) => (n.freq[i] ? r : 0));
    const weight = POSITIONS.reduce((w, p) => w * massOf(p === n.actor ? heroReach : reach[p]), 1);
    spots.push({ nodeId: n.id, hero: n.actor, heroReach, weight });
    n.actions.forEach((a, j) => {
      if (!a.child) return;
      const next = { ...reach, [n.actor]: hero.map((r, i) => r * (n.freq[i]?.[j] ?? 0)) } as Record<Position, number[]>;
      walk(byId.get(a.child)!, next);
    });
  };
  walk(pack.nodes[0], { BTN: ones(), SB: ones(), BB: ones() });
  return spots;
}

export interface SampleOpts { uniformSpots?: boolean; positionFilter?: Position }
function pickWeighted(weights: number[], rng: Rng): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (let i = 0; i < weights.length; i++) { if (weights[i] > 0 && (x -= weights[i]) < 0) return i; }
  return weights.map((w) => w > 0).lastIndexOf(true);
}
export function sampleSpot(spots: Spot[], rng: Rng, opts: SampleOpts = {}): Spot {
  const c = spots.filter((s) => s.weight > 0 && (!opts.positionFilter || s.hero === opts.positionFilter));
  if (!c.length) throw new Error('no playable spots');
  return c[pickWeighted(c.map((s) => (opts.uniformSpots ? 1 : s.weight)), rng)];
}

export interface Deal { classIdx: number; hand: string; cards: [string, string] }
const SUITS = 'shdc';
export function dealHand(spot: Spot, rng: Rng): Deal {
  const classIdx = pickWeighted(spot.heroReach.map((r, i) => r * COMBOS[i]), rng);
  const cls = CLASSES[classIdx];
  const combos: [string, string][] = [];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    const ok = cls.length === 2 ? a < b : cls[2] === 's' ? a === b : a !== b;
    if (ok) combos.push([cls[0] + SUITS[a], cls[1] + SUITS[b]]);
  }
  const cards = combos[Math.min(combos.length - 1, Math.floor(rng() * combos.length))];
  return { classIdx, hand: cards.join(''), cards };
}

// ---- buttons
export type Button = 'FOLD' | 'CALL' | 'RAISE' | '3BET' | 'ALLIN';
export interface ButtonSpec { button: Button; actionIds: string[]; sizesBb: number[]; isCheck: boolean }
export const SHOVE_FRACTION = 0.95;

/** Effective stack (total, before ante) = min(hero, biggest live opponent). */
export function effectiveStack(stacks: Stacks, hero: Position, folded: Record<Position, boolean>): number {
  const opp = POSITIONS.filter((p) => p !== hero && !folded[p]).map((p) => stacks[p]);
  return Math.min(stacks[hero], opp.length ? Math.max(...opp) : stacks[hero]);
}
export function buttonOf(a: PackAction, node: PackNode, pack: Pack): Button {
  if (a.kind === 'fold') return 'FOLD';
  if (a.kind === 'call' || a.kind === 'check') return 'CALL';
  const r = replay(pack.meta, node.history);
  if (a.kind === 'allin' || (a.toBb ?? 0) >= SHOVE_FRACTION * (effectiveStack(pack.meta.stacksBb, node.actor, r.folded) - pack.meta.anteBb)) return 'ALLIN';
  return node.history.some((h) => h.act === 'R' || h.act === 'A') ? '3BET' : 'RAISE';
}
export function mapButtons(node: PackNode, pack: Pack): ButtonSpec[] {
  const out = new Map<Button, ButtonSpec>();
  for (const a of node.actions) {
    const b = buttonOf(a, node, pack);
    const s = out.get(b) ?? { button: b, actionIds: [], sizesBb: [], isCheck: b === 'CALL' && node.toCallBb === 0 };
    s.actionIds.push(a.id);
    if (a.toBb != null && (b === 'RAISE' || b === '3BET' || b === 'ALLIN')) s.sizesBb.push(a.toBb);
    out.set(b, s);
  }
  return [...out.values()];
}

// ---- situation descriptor
export interface Situation {
  nodeId: string; hero: Position; heroStackBb: number; effectiveStackBb: number; potBb: number; toCallBb: number;
  rivals: { pos: Position; stackBb: number; folded: boolean; actions: { act: string; toBb: number | null }[] }[];
  buttons: ButtonSpec[];
}
export function describeSituation(node: PackNode, pack: Pack): Situation {
  const r = replay(pack.meta, node.history);
  return {
    nodeId: node.id, hero: node.actor, heroStackBb: pack.meta.stacksBb[node.actor],
    effectiveStackBb: effectiveStack(pack.meta.stacksBb, node.actor, r.folded),
    potBb: node.potBb, toCallBb: node.toCallBb,
    rivals: POSITIONS.filter((p) => p !== node.actor).map((p) => ({
      pos: p, stackBb: pack.meta.stacksBb[p], folded: r.folded[p],
      actions: node.history.filter((h) => h.pos === p).map((h) => ({ act: h.act, toBb: h.toBb })),
    })),
    buttons: mapButtons(node, pack),
  };
}

// ---- scoring
export interface ScoreOpts { threshold?: number; strict?: boolean; closeEvLossBb?: number }
export interface ScoreResult {
  actionId: string; freq: number; correct: boolean; score: number; close: boolean;
  evLoss: number | null; bestActionId: string;
}
export const DEFAULT_THRESHOLD = 0.1;
export const CLOSE_EV_LOSS_BB = 0.05;
export function scoreAnswer(node: PackNode, classIdx: number, actionId: string, opts: ScoreOpts = {}): ScoreResult {
  const row = node.freq[classIdx];
  const j = node.actions.findIndex((a) => a.id === actionId);
  if (!row) throw new Error(`class ${CLASSES[classIdx]} has reach 0 at ${node.id}`);
  if (j < 0) throw new Error(`unknown action ${actionId}`);
  const freq = row[j];
  const correct = freq >= (opts.threshold ?? DEFAULT_THRESHOLD) - 1e-9;
  const ev = node.ev?.[classIdx];
  const evLoss = ev ? Math.max(...ev) - ev[j] : null;
  const best = row.indexOf(Math.max(...row));
  return {
    actionId, freq, correct, score: opts.strict ? freq : correct ? 1 : 0,
    close: !correct && evLoss !== null && evLoss <= (opts.closeEvLossBb ?? CLOSE_EV_LOSS_BB) + 1e-9,
    evLoss, bestActionId: node.actions[best].id,
  };
}

// ---- explanation params (data only; the UI fills i18n templates)
export interface ExplainParams {
  handClass: string; hero: Position; potBb: number; toCallBb: number; potOdds: number; spr: number;
  freqs: { actionId: string; button: Button; freq: number }[];
  chosenActionId: string; chosenFreq: number; bestActionId: string; bestFreq: number; evLoss: number | null;
  /** Share (0..1) of the node's range combos whose chosen-action frequency is strictly higher than this class's. */
  chosenRangeRank: number;
}
export function explain(node: PackNode, pack: Pack, spot: Spot, classIdx: number, actionId: string): ExplainParams {
  const s = scoreAnswer(node, classIdx, actionId);
  const row = node.freq[classIdx]!;
  const j = node.actions.findIndex((a) => a.id === actionId);
  let above = 0, total = 0;
  node.freq.forEach((r, i) => {
    const w = r ? spot.heroReach[i] * COMBOS[i] : 0;
    total += w;
    if (r && r[j] > row[j]) above += w;
  });
  const sit = describeSituation(node, pack);
  const behind = sit.effectiveStackBb - replay(pack.meta, node.history).committed[node.actor] - pack.meta.anteBb;
  return {
    handClass: CLASSES[classIdx], hero: node.actor, potBb: node.potBb, toCallBb: node.toCallBb,
    potOdds: node.toCallBb / (node.potBb + node.toCallBb), spr: behind / node.potBb,
    freqs: node.actions.map((a, k) => ({ actionId: a.id, button: buttonOf(a, node, pack), freq: row[k] })),
    chosenActionId: actionId, chosenFreq: s.freq, bestActionId: s.bestActionId, bestFreq: Math.max(...row),
    evLoss: s.evLoss, chosenRangeRank: total ? above / total : 0,
  };
}

// ---- session stats
export interface SessionStats { correct: number; incorrect: number; total: number; scoreSum: number }
export const emptyStats: SessionStats = { correct: 0, incorrect: 0, total: 0, scoreSum: 0 };
export function sessionReducer(s: SessionStats, r: Pick<ScoreResult, 'correct' | 'score'>): SessionStats {
  return { correct: s.correct + (r.correct ? 1 : 0), incorrect: s.incorrect + (r.correct ? 0 : 1), total: s.total + 1, scoreSum: s.scoreSum + r.score };
}
/** Accuracy %: correct/total, or in strict mode sum(score)/total (score = chosen frequency). */
export function accuracyPct(s: SessionStats, strict = false): number {
  return s.total ? ((strict ? s.scoreSum : s.correct) / s.total) * 100 : 0;
}
