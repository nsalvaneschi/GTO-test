// preflop3 solution-pack types (schemaVersion 1). See docs/preflop3-design.md.
export const CURRENT_SCHEMA_VERSION = 1;
export const POSITIONS = ['BTN', 'SB', 'BB'] as const;
export type Position = (typeof POSITIONS)[number];
export type Verification = 'external-verified' | 'self-computed-unverified' | 'test-fixture';
export const VERIFICATIONS: readonly Verification[] = ['external-verified', 'self-computed-unverified', 'test-fixture'];
export type ActionKind = 'fold' | 'call' | 'check' | 'raise' | 'allin';
export const ACTION_KINDS: readonly ActionKind[] = ['fold', 'call', 'check', 'raise', 'allin'];
export type HistAct = 'F' | 'C' | 'R' | 'A';
export type Terminal = 'showdown-allin' | 'fold' | 'flop';
export const TERMINALS: readonly Terminal[] = ['showdown-allin', 'fold', 'flop'];
export type Stacks = Record<Position, number>;

export interface PackMeta {
  schemaVersion: number;
  packId: string;
  verification: Verification;
  source: { kind: 'external' | 'self' | 'synthetic'; solver: string; version: string };
  settings: Record<string, unknown>;
  players: 3;
  stacksBb: Stacks;
  blinds: { sb: number; bb: number };
  anteBb: number;
  rake: { pct: number; capBb: number } | null;
  payoff: 'chipEV' | 'ICM';
  icmPayouts: number[] | null;
  betMenu: number[];
  convergence: { metric: 'max-player-br-gain-mbb' | 'exploitability-mbb' | 'unknown'; value: number | null };
  date: string;
  license: string;
  notes: string;
}
export interface HistoryEntry { pos: Position; act: HistAct; toBb: number | null }
export interface PackAction { id: string; kind: ActionKind; toBb: number | null; child: string | null; terminal?: Terminal }
/** One row per class (canonical order); null = actor never holds the class here (reach 0). */
export type ClassRows = (number[] | null)[];
export interface PackNode {
  id: string;
  actor: Position;
  history: HistoryEntry[];
  potBb: number;
  toCallBb: number;
  /** Remaining stacks behind (after ante and bets). */
  stacksBb: Stacks;
  actions: PackAction[];
  freq: ClassRows;
  ev?: ClassRows;
}
export interface Pack { meta: PackMeta; classes: string[]; nodes: PackNode[] }

export const ERROR_CODES = [
  'E_STRUCTURE', 'E_SCHEMA_VERSION', 'E_VERIFICATION', 'E_META_FIELD', 'E_ICM_PAYOUTS', 'E_CLASSES',
  'E_DUP_ID', 'E_ACTOR', 'E_HISTORY', 'E_ACTION_KIND', 'E_CHILD_MISSING', 'E_TERMINAL', 'E_UNREACHABLE',
  'E_CLASS_COVERAGE', 'E_ROW_WIDTH', 'E_NUMBER', 'E_SUM', 'E_EV_SHAPE',
  'E_POT', 'E_TOCALL', 'E_STACK', 'E_TOBB', 'E_FIXTURE_IN_PROD',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface PackError { path: string; code: ErrorCode; detail: string }

const RANKS = 'AKQJT98765432';
/** Canonical 169 order: AA, AKs, AKo, AQs, AQo, ..., A2o, KK, KQs, ..., 22. */
export const CLASSES: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 13; i++) {
    out.push(RANKS[i] + RANKS[i]);
    for (let j = i + 1; j < 13; j++) out.push(RANKS[i] + RANKS[j] + 's', RANKS[i] + RANKS[j] + 'o');
  }
  return out;
})();
export const CLASS_INDEX: Record<string, number> = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
export function comboCount(cls: string): number { return cls.length === 2 ? 6 : cls[2] === 's' ? 4 : 12; }

export interface Replay {
  committed: Stacks; folded: Record<Position, boolean>; currentBet: number; potBb: number; remaining: Stacks;
}
/** Replays a history from the blinds. Ante is dead money (not part of bets). */
export function replay(meta: Pick<PackMeta, 'stacksBb' | 'blinds' | 'anteBb'>, history: HistoryEntry[]): Replay {
  const committed: Stacks = { BTN: 0, SB: meta.blinds.sb, BB: meta.blinds.bb };
  const folded: Record<Position, boolean> = { BTN: false, SB: false, BB: false };
  let currentBet = meta.blinds.bb;
  for (const h of history) {
    if (h.act === 'F') folded[h.pos] = true;
    else if (h.act === 'C') committed[h.pos] = currentBet;
    else { committed[h.pos] = h.toBb as number; currentBet = Math.max(currentBet, committed[h.pos]); }
  }
  const a = meta.anteBb;
  return {
    committed, folded, currentBet,
    potBb: committed.BTN + committed.SB + committed.BB + 3 * a,
    remaining: { BTN: meta.stacksBb.BTN - a - committed.BTN, SB: meta.stacksBb.SB - a - committed.SB, BB: meta.stacksBb.BB - a - committed.BB },
  };
}
