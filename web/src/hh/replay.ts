// Pure helpers for the hand-replay page: board / pot / stacks at a step, and the stored decision rows of a hand.
// The stored hand has no button or blind postings, so the pot shown is the exact pot at the START of the street and
// each seat's chips in this street come from its actions (a preflop check is the big blind, 1 bb).
import type { HhDecisionRow, HhHandFull } from '../api';

export type StoredHand = HhHandFull['hand'];
export const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
const BOARD_LEN: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

export interface ReplayState {
  street: string; board: string[]; potStart: number; folded: number[];
  inStreet: Record<number, number>; // chips each seat has put in during the current street
  stacks: Record<number, number>; // stack behind at this step for seats still in the hand
}

/** State after the first `step` actions (0 = start of hand). */
export function replayAt(h: StoredHand, step: number): ReplayState {
  const shown = h.actions.slice(0, step);
  const street = shown.length ? shown[shown.length - 1].street : 'preflop';
  const si = STREETS.indexOf(street as (typeof STREETS)[number]);
  const committed: Record<number, number> = {}; // before the current street
  const folded = new Set<number>();
  let cur: Record<number, number> = {}, curStreet = 'preflop';
  const close = () => { for (const [s, v] of Object.entries(cur)) committed[+s] = (committed[+s] ?? 0) + v; cur = {}; };
  for (const a of shown) {
    if (a.street !== curStreet) { close(); curStreet = a.street; }
    if (a.kind === 'fold') folded.add(a.seat);
    const to = a.amount_to ?? (a.street === 'preflop' && a.kind === 'check' ? 1 : null);
    if (to !== null) cur[a.seat] = Math.max(cur[a.seat] ?? 0, to);
  }
  const stacks: Record<number, number> = {};
  for (const s of h.seats) if (!folded.has(s.seat)) stacks[s.seat] = Math.max(0, s.stack - (committed[s.seat] ?? 0) - (cur[s.seat] ?? 0));
  return { street, board: h.board.slice(0, BOARD_LEN[street] ?? 0), potStart: h.pot_by_street[si] ?? 0, folded: [...folded], inStreet: cur, stacks };
}

export interface ParsedPath { actionIndex: number; path: string; labels: string[] }
/** Decision rows are keyed `a<actionIndex>[/<tree path>/<action labels>]` (see analyze.ts). */
export function parseNodePath(p: string): ParsedPath | null {
  const m = /^a(\d+)(?:\/([^/]*)\/([^/]*))?$/.exec(p);
  return m ? { actionIndex: +m[1], path: m[2] ?? '', labels: m[3] ? m[3].split('.') : [] } : null;
}

/** Stored decision of the hero action at `actionIndex`, with its parsed labels. */
export function decisionAt(ds: HhDecisionRow[], actionIndex: number): { row: HhDecisionRow; labels: string[] } | null {
  for (const row of ds) { const p = parseNodePath(row.nodePath); if (p && p.actionIndex === actionIndex) return { row, labels: p.labels }; }
  return null;
}

/** Label token -> i18n action key and size (pot fraction) for display; bare percentages are never shown without a name. */
export function labelKey(token: string): { key: 'action.fold' | 'action.call' | 'action.check' | 'action.allin' | 'action.bet' | 'action.raise'; pct: number | null } {
  if (token === 'f') return { key: 'action.fold', pct: null };
  if (token === 'c') return { key: 'action.call', pct: null };
  if (token === 'x') return { key: 'action.check', pct: null };
  if (token === 'a') return { key: 'action.allin', pct: null };
  return { key: token[0] === 'r' ? 'action.raise' : 'action.bet', pct: Number(token.slice(1)) / 100 };
}
