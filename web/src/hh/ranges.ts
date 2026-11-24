// Hand-written, APPROXIMATE preflop range presets for hand-history analysis (docs/handhistory-design.md section 3).
// These are typical 6-max 100bb opening / defending shapes written by hand. They are NOT solver output and have
// not been validated against one. Everything derived from them is shown as "approximate" in the UI.
import { parseRange } from '../ranges';
import type { Hand } from './types';

/** Token syntax: "AA", "AKs", "AQo", "77+" (pairs up), "ATs+" (kicker up to below the first rank), "22-TT", "A5s-A9s". */
export function expand(spec: string): string {
  const R = '23456789TJQKA';
  const out: string[] = [];
  for (const tok of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([2-9TJQKA])([2-9TJQKA])([so]?)(\+|-([2-9TJQKA])([2-9TJQKA])\3)?$/.exec(tok);
    if (!m) { out.push(tok); continue; }
    const [, a, b, k, ext, a2, b2] = m;
    if (!ext) { out.push(tok); continue; }
    if (a === b) { // pairs
      const hi = ext === '+' ? 12 : R.indexOf(a2);
      for (let r = R.indexOf(a); r <= hi; r++) out.push(R[r] + R[r]);
    } else {
      const hi = ext === '+' ? R.indexOf(a) - 1 : R.indexOf(b2);
      for (let r = R.indexOf(b); r <= hi; r++) out.push(a + R[r] + k);
    }
  }
  return out.join(',');
}

/** Range spec ("AA,AKs-AJs,...") to sparse engine map. */
export const rangeOf = (spec: string) => parseRange(expand(spec));

// Opening ranges by position (first raiser, folded to).
export const OPEN: Record<string, string> = {
  UTG: '66+,A2s+,ATo+,KTs+,KJo+,QTs+,JTs,T9s,98s,87s,76s,65s',
  HJ: '55+,A2s+,A9o+,K9s+,KTo+,Q9s+,QTo+,J9s+,JTo,T9s,98s,87s,76s,65s,54s',
  CO: '44+,A2s+,A8o+,K6s+,K9o+,Q8s+,Q9o+,J8s+,J9o+,T8s+,T9o,97s+,86s+,75s+,65s,54s',
  BTN: '22+,A2s+,A2o+,K2s+,K7o+,Q4s+,Q9o+,J6s+,J9o+,T6s+,T8o+,96s+,98o,85s+,75s+,64s+,54s,53s',
  SB: '22+,A2s+,A4o+,K4s+,K9o+,Q6s+,QTo+,J7s+,JTo,T7s+,97s+,87s,76s,65s,54s',
};
// Calling range against a single open (3-bet hands removed, roughly).
export const CALL: Record<string, string> = {
  BB: '22-TT,A2s-AJs,A5o-AJo,K2s-KJs,K9o-KJo,Q4s-QJs,QTo-QJo,J6s-JTs,J9o-JTo,T6s-T9s,T8o-T9o,96s-98s,98o,85s-87s,74s-76s,64s-65s,53s-54s',
  SB: '22-99,A2s-ATs,KTs-KQs,QTs-QJs,JTs,T9s,98s,87s,76s,65s',
  BTN: '22-TT,A5s-AQs,AJo-AQo,KTs-KQs,KJo-KQo,QTs-QJs,JTs,T9s,98s,87s,76s,65s',
  CO: '22-99,ATs-AQs,AJo-AQo,KTs-KQs,QTs-QJs,JTs,T9s,98s,87s',
  HJ: '22-99,AJs-AQs,KQs,QJs,JTs,T9s',
};
// 3-betting range by position (linear/polar mix), and the opener's range for calling a 3-bet.
export const THREEBET: Record<string, string> = {
  BB: '99+,AJs+,A5s-A4s,KQs,AQo+,76s,65s',
  SB: '99+,AJs+,A5s-A3s,KQs,AQo+',
  BTN: '88+,ATs+,A5s-A4s,KQs,AJo+,KQo,76s',
  CO: '99+,AJs+,A5s,KQs,AQo+',
  HJ: 'TT+,AQs+,AKo,A5s',
};
export const CALL3: Record<string, string> = {
  UTG: 'TT-QQ,AJs-AQs,KQs,AQo',
  HJ: '88-QQ,AJs-AQs,KQs,JTs,AQo',
  CO: '77-QQ,AJs-AQs,KQs,QJs,JTs,T9s,AQo',
  BTN: '77-QQ,AJs-AQs,A5s-A4s,KJs-KQs,QJs,JTs,T9s,98s,AQo',
  SB: '77-QQ,AJs-AQs,KQs,JTs,T9s,AQo',
};

/**
 * Narrowing to the river (heuristic, documented): per player the earlier-street line picks `top` = share of the preset
 * combos kept from the top by river equity, plus `bluff` = share of the preset size added from the bottom by equity
 * (bluffs / air). A user width override replaces `top` for both players.
 */
export type Line = 'aggr' | 'call' | 'check';
export const NARROW: Record<Line, { top: number; bluff: number }> = {
  aggr: { top: 0.55, bluff: 0.1 },
  call: { top: 0.55, bluff: 0.05 },
  check: { top: 0.85, bluff: 0 },
};

const alias = (p: string) => (p === 'UTG1' || p === 'UTG2' ? 'UTG' : p === 'MP' ? 'HJ' : p);

/** Position of every seat, from the button (seats are those dealt in). */
export function positions(hand: Pick<Hand, 'seats' | 'button'>): Record<number, string> {
  const seats = hand.seats.map((s) => s.seat).sort((a, b) => a - b);
  const bi = Math.max(0, seats.indexOf(hand.button));
  const order = [...seats.slice(bi), ...seats.slice(0, bi)];
  const n = order.length;
  const names = n === 2 ? ['BTN', 'BB'] : ['BTN', 'SB', 'BB', ...['UTG', 'UTG1', 'UTG2', 'MP', 'HJ', 'CO'].slice(-(n - 3))];
  // blinds are BTN, SB, BB; the rest run UTG (first to act) ... CO (last before the button)
  const pos: Record<number, string> = {};
  order.forEach((s, i) => { pos[s] = names[i]; });
  return pos;
}

export type PotType = 'limp' | 'srp' | '3bp' | '4bp';
export interface Preset { name: string; potType: PotType; spec: Record<number, string> }

/** Preset (name + range spec per seat) for the two river players, or null when the pot type/positions are not covered. */
export function presetFor(hand: Hand, a: number, b: number): Preset | null {
  const pos = positions(hand);
  const raises = hand.actions.filter((x) => x.street === 'preflop' && (x.kind === 'raise' || x.kind === 'allin'));
  const potType: PotType = raises.length > 2 ? '4bp' : (['limp', 'srp', '3bp'] as const)[raises.length];
  const pair = new Set([a, b]);
  if (potType === 'srp') {
    const opener = raises[0].seat, other = pair.has(opener) ? (a === opener ? b : a) : -1;
    const o = OPEN[alias(pos[opener])], c = CALL[alias(pos[other])];
    if (!o || !c) return null;
    return { name: `srp:${alias(pos[opener])}-${alias(pos[other])}`, potType, spec: { [opener]: o, [other]: c } };
  }
  if (potType === '3bp') {
    const [opener, tb] = [raises[0].seat, raises[1].seat];
    if (!pair.has(opener) || !pair.has(tb) || opener === tb) return null;
    const o = CALL3[alias(pos[opener])], t = THREEBET[alias(pos[tb])];
    if (!o || !t) return null;
    return { name: `3bp:${alias(pos[opener])}-${alias(pos[tb])}`, potType, spec: { [opener]: o, [tb]: t } };
  }
  return null;
}
