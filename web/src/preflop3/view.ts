// Pure view-model logic for the preflop 3-max trainer screen (no DOM, no text: callers map keys to i18n).
import { CLASSES, CLASS_INDEX, POSITIONS, replay, type Pack, type PackAction, type PackNode, type Position, type Verification } from './types';
import { buttonOf, emptyStats, type Button, type Rng, type ScoreResult, type SessionStats } from './trainer';

export const STACKS = [20, 18, 16] as const;
export type Mode = '20' | '18' | '16' | 'mix';
export const MODES: Mode[] = ['20', '18', '16', 'mix'];
export type Verdict = 'correct' | 'close' | 'incorrect';
export type BadgeKind = 'verified' | 'unverified' | 'test';

/** Stack (bb) a pack is for: all three stacks equal and one of STACKS, else null (unsupported). */
export function stackOf(pack: Pack): number | null {
  const s = pack.meta.stacksBb;
  return s.BTN === s.SB && s.SB === s.BB && (STACKS as readonly number[]).includes(s.BTN) ? s.BTN : null;
}
export interface ModeState { mode: Mode; enabled: boolean }
export function modeStates(packs: Map<number, Pack>): { modes: ModeState[]; missing: number[] } {
  const missing = STACKS.filter((s) => !packs.has(s));
  return { modes: MODES.map((m) => ({ mode: m, enabled: m === 'mix' ? packs.size > 0 : packs.has(+m) })), missing };
}
/** Pack for a mode: a fixed stack, or for 'mix' one of the loaded stacks uniformly. */
export function pickPack(mode: Mode, packs: Map<number, Pack>, rng: Rng): { stack: number; pack: Pack } | null {
  const stacks = mode === 'mix' ? [...packs.keys()].sort((a, b) => b - a) : packs.has(+mode) ? [+mode] : [];
  if (!stacks.length) return null;
  const stack = stacks[Math.min(stacks.length - 1, Math.floor(rng() * stacks.length))];
  return { stack, pack: packs.get(stack)! };
}

export const badgeKind = (v: Verification): BadgeKind => (v === 'external-verified' ? 'verified' : v === 'self-computed-unverified' ? 'unverified' : 'test');
export const verdictOf = (s: Pick<ScoreResult, 'correct' | 'close'>): Verdict => (s.correct ? 'correct' : s.close ? 'close' : 'incorrect');

export const spotIdOf = (stack: number, nodeId: string, hero: Position) => `preflop3:${stack}:${nodeId}:${hero}`;
/** Body for POST /api/drills/results. evLoss is 0 when the pack has no EV (meta.evKnown tells the server). */
export function resultBody(o: { stack: number; pack: Pack; node: PackNode; classIdx: number; combo: string; actionIdx: number; score: ScoreResult; ms: number; lang: string }) {
  const hero = o.node.actor;
  return {
    spotId: spotIdOf(o.stack, o.node.id, hero), hero: POSITIONS.indexOf(hero), handCombo: o.combo, action: o.actionIdx,
    solverFreqs: o.node.freq[o.classIdx]!, evLoss: o.score.evLoss ?? 0,
    ms: Math.max(0, Math.min(3600000, Math.round(o.ms))), lang: o.lang,
    meta: { packId: o.pack.meta.packId, verification: o.pack.meta.verification, verdict: verdictOf(o.score), evKnown: o.score.evLoss !== null },
  };
}
const RANK_ORDER = 'AKQJT98765432';
// ---- seats and situation
export type ChipKind = 'fold' | 'raise' | 'call' | 'allin' | 'blind' | 'none';
export interface SeatView { pos: Position; stackBb: number; folded: boolean; hero: boolean; dealer: boolean; chip: { kind: ChipKind; bb: number | null } }
export function seatViews(node: PackNode, pack: Pack): SeatView[] {
  const r = replay(pack.meta, node.history);
  return POSITIONS.map((pos) => {
    const last = [...node.history].reverse().find((h) => h.pos === pos);
    const chip: SeatView['chip'] = last
      ? last.act === 'F' ? { kind: 'fold', bb: null } : last.act === 'C' ? { kind: 'call', bb: null }
        : last.act === 'R' ? { kind: 'raise', bb: last.toBb } : { kind: 'allin', bb: last.toBb }
      : pos === 'SB' ? { kind: 'blind', bb: pack.meta.blinds.sb } : pos === 'BB' ? { kind: 'blind', bb: pack.meta.blinds.bb } : { kind: 'none', bb: null };
    return { pos, stackBb: node.stacksBb[pos], folded: r.folded[pos], hero: pos === node.actor, dealer: pos === 'BTN', chip };
  });
}
export type SitKey = 'first' | 'limp' | 'facingRaise' | 'facing3bet' | 'facing4bet' | 'facingAllin';
export function situationOf(node: PackNode): { key: SitKey; villain: Position | null; sizeBb: number | null; folded: Position[] } {
  const folded = node.history.filter((h) => h.act === 'F').map((h) => h.pos);
  const raises = node.history.filter((h) => h.act === 'R' || h.act === 'A');
  const last = raises[raises.length - 1];
  if (!last) {
    const limp = node.history.find((h) => h.act === 'C');
    return { key: limp ? 'limp' : 'first', villain: limp?.pos ?? null, sizeBb: null, folded };
  }
  const key: SitKey = last.act === 'A' ? 'facingAllin' : raises.length === 1 ? 'facingRaise' : raises.length === 2 ? 'facing3bet' : 'facing4bet';
  return { key, villain: last.pos, sizeBb: last.toBb, folded };
}

// ---- buttons
export const BUTTON_ORDER: Button[] = ['FOLD', 'CALL', 'RAISE', '3BET', 'ALLIN'];
export const BUTTON_KEY: Record<Button, string> = { FOLD: 'F', CALL: 'C', RAISE: 'R', '3BET': '3', ALLIN: 'A' };
export const BUTTON_COLOR: Record<Button, string> = { FOLD: 'var(--fold)', CALL: 'var(--call)', RAISE: 'var(--b1)', '3BET': 'var(--b2)', ALLIN: 'var(--b3)' };
export interface ActionView { actionId: string; idx: number; button: Button; check: boolean; sizeBb: number | null }
/** One entry per action at the node, ordered by button; size = raise/all-in target or the amount to call. */
export function actionViews(node: PackNode, pack: Pack): ActionView[] {
  return node.actions.map((a: PackAction, idx) => {
    const button = buttonOf(a, node, pack);
    const sizeBb = button === 'CALL' ? (node.toCallBb > 0 ? node.toCallBb : null) : button === 'FOLD' ? null : a.toBb;
    return { actionId: a.id, idx, button, check: button === 'CALL' && node.toCallBb === 0, sizeBb };
  }).sort((a, b) => BUTTON_ORDER.indexOf(a.button) - BUTTON_ORDER.indexOf(b.button));
}
/** Action to trigger for a shortcut key (first action of that button), or undefined. */
export function actionForKey(views: ActionView[], key: string): ActionView | undefined {
  const k = key.toUpperCase();
  return views.find((v) => BUTTON_KEY[v.button] === k);
}

// ---- 13x13 matrix
export interface MatrixCell { name: string; idx: number; mix: number[] | null; me: boolean }
export function matrixCells(node: PackNode, heroClass: string): MatrixCell[] {
  const out: MatrixCell[] = [];
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const hi = Math.min(i, j), lo = Math.max(i, j);
    const name = RANK_ORDER[hi] + RANK_ORDER[lo] + (i === j ? '' : i < j ? 's' : 'o');
    const idx = CLASS_INDEX[name];
    out.push({ name, idx, mix: node.freq[idx] ?? null, me: name === heroClass });
  }
  return out;
}
/** CSS background for a cell: horizontal stripes proportional to the action mix. */
export function cellBackground(mix: number[], colors: string[]): string {
  let acc = 0;
  const stops = mix.map((p, k) => { const s = `${colors[k]} ${acc * 100}% ${(acc + p) * 100}%`; acc += p; return s; });
  return `linear-gradient(to right, ${stops.join(',')})`;
}
export { CLASSES };

// ---- score persistence (sessionStorage, validated) and server mapping
export const SESSION_KEY = 'gto-p3-session';
export function parseSession(raw: string | null): SessionStats {
  try {
    const o = JSON.parse(raw ?? '');
    const ok = ['correct', 'incorrect', 'total', 'scoreSum'].every((k) => Number.isFinite(o?.[k]) && o[k] >= 0);
    return ok && o.correct + o.incorrect === o.total ? { correct: o.correct, incorrect: o.incorrect, total: o.total, scoreSum: o.scoreSum } : emptyStats;
  } catch { return emptyStats; }
}
export function fromServer(p: { correct: number; close: number; incorrect: number; total: number }): SessionStats {
  return { correct: p.correct, incorrect: p.close + p.incorrect, total: p.total, scoreSum: p.correct };
}
