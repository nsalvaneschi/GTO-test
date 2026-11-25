// Normalized hand-history schema (docs/handhistory-design.md). Amounts are in big blinds
// (rounded to 4 decimals) except `stakes`, which is in the hand's currency units.
export type Site = 'pokerstars' | 'ggpoker' | 'ipoker';
export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export type ReasonCode =
  | 'unsupported_format' // not a PokerStars/GGPoker/iPoker English header
  | 'tournament'
  | 'unsupported_game' // PLO, limit, other variants
  | 'run_it_twice'
  | 'bad_header'
  | 'no_seats'
  | 'no_button'
  | 'no_blinds'
  | 'bad_structure' // missing/duplicate/out-of-order street markers or board size
  | 'bad_card'
  | 'duplicate_card'
  | 'unknown_player'
  | 'bad_action'
  | 'bad_amount'
  | 'stack_overflow'
  | 'pot_mismatch'
  | 'truncated';

export type WarningCode = 'side_pots' | 'no_hero';

export interface Seat {
  seat: number;
  name: string; // plaintext as parsed; caller hashes villains (name_hash) before storing
  name_hash: string | null;
  stack: number; // bb, at hand start
  is_hero: boolean;
}

export interface Blind {
  seat: number;
  kind: 'sb' | 'bb' | 'sb+bb' | 'post' | 'ante';
  amount: number;
}

export interface Action {
  street: Street;
  seat: number;
  kind: ActionKind; // 'allin' = all-in bet/raise; all-in calls stay 'call'
  amount_to: number | null; // total committed by seat on this street after the action (bb)
  allin: boolean;
}

export interface StreetState {
  street: Street;
  pot: number; // bb at start of the street's action (preflop: after blinds/antes)
  stacks: Record<number, number>; // remaining stack per seat at that point
}

export interface Hand {
  site: Site;
  hand_id: string;
  played_at: string | null; // local time as printed, ISO-like, no timezone
  stakes: { sb: number; bb: number };
  button: number;
  hero: number | null;
  seats: Seat[];
  hero_cards: string[] | null;
  board: string[];
  blinds: Blind[];
  actions: Action[];
  pot_by_street: StreetState[];
  returned: { seat: number; amount: number }[]; // uncalled bets returned
  contributions: Record<number, number>; // per seat, after returns; sums to final_pot
  final_pot: number;
  collected: Record<number, number>;
  final_stacks: Record<number, number>; // start - contribution + collected (rake is the difference)
  went_to_showdown: boolean;
  showdown: { seat: number; cards: string[] }[];
}

export type ParseResult =
  | { ok: true; index: number; hand: Hand; warnings: WarningCode[] }
  | { ok: false; index: number; reason: ReasonCode; site?: Site; hand_id?: string; line?: number };

export interface ParseSummary {
  results: ParseResult[];
  counts: Record<string, number>; // 'ok' and reason codes
}
