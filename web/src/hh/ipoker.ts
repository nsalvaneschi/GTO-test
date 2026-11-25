// iPoker (Hold'em Manager 3 text export) adapter. Pure TS, no I/O. See docs/handhistory-design.md.
// Format facts (verified by arithmetic over real exports, aggregate only):
//  - Call and Allin amounts are chips ADDED now; Bet and Raise amounts are the street TOTAL ("to").
//  - Uncalled bets are never printed: the summary pot excludes them, so we derive the return.
//  - Cards are suit letter + rank (ten is "10"); the turn/river line carries only the new card.
import type { Action, ActionKind, Blind, Hand, ReasonCode, Seat, Site, Street, StreetState, WarningCode } from './types';

export class IpFail extends Error {
  constructor(public reason: ReasonCode, public line?: number) { super(reason); }
}

export const IPK_HEADER = /^GAME #(\d+) Version:\S* (?:Uncalled:\S* )?(.*)$/;
const EPS = 0.011;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const ORDER: Street[] = ['preflop', 'flop', 'turn', 'river'];

function money(s: string, line: number): number {
  const t = s.replace(/[$€£,]/g, '');
  if (!/^\d*\.?\d+$/.test(t)) throw new IpFail('bad_amount', line);
  return parseFloat(t);
}

function card(s: string, line: number): string {
  const m = /^([SHDC])(10|[2-9JQKA])$/.exec(s);
  if (!m) throw new IpFail('bad_card', line);
  return (m[2] === '10' ? 'T' : m[2]) + m[1].toLowerCase();
}
const cardList = (s: string, n: number, line: number): string[] => {
  const c = s.trim().split(/\s+/);
  if (c.length !== n) throw new IpFail('bad_card', line);
  return c.map((x) => card(x, line));
};

export function buildIpoker(lines: string[], info: { site?: Site; hand_id?: string }): { hand: Hand; warnings: WarningCode[] } {
  const head = IPK_HEADER.exec(lines[0].trim());
  if (!head) throw new IpFail('unsupported_format', 1);
  const site: Site = 'ipoker';
  const hand_id = head[1];
  info.site = site;
  info.hand_id = hand_id;
  const rest = head[2];
  if (/Tournament|\bLevel\b/i.test(rest)) throw new IpFail('tournament', 1);
  if (/Omaha|Razz|Stud|Draw|Short/i.test(rest) || !/Texas Hold'em NL\b/.test(rest)) throw new IpFail('unsupported_game', 1);
  const st = /NL\s+[^\d\s]?([\d.,]+)\/[^\d\s]?([\d.,]+)/.exec(rest);
  if (!st) throw new IpFail('bad_header', 1);
  const sbU = money(st[1], 1);
  const bbU = money(st[2], 1);
  if (!(bbU > 0) || sbU > bbU) throw new IpFail('bad_header', 1);
  const dt = /(\d{4})-(\d\d)-(\d\d) (\d\d:\d\d:\d\d)/.exec(rest);
  const played_at = dt ? `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}` : null;
  const bb = (x: number) => r4(x / bbU);

  let button = -1;
  const seatRows: { seat: number; name: string; stackU: number }[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^Table Size \d+$/.test(l) || /^Table .*,/.test(l)) continue;
    const s = /^Seat (\d+): (.+?) \(([^)]*?) in chips\)(\s+DEALER)?\s*$/.exec(l);
    if (s) {
      if (seatRows.some((x) => x.seat === +s[1])) throw new IpFail('bad_structure', i + 1);
      seatRows.push({ seat: +s[1], name: s[2], stackU: money(s[3].trim(), i + 1) });
      if (s[4]) { if (button >= 0) throw new IpFail('bad_structure', i + 1); button = +s[1]; }
      continue;
    }
    break;
  }
  if (seatRows.length < 2) throw new IpFail('no_seats');
  if (button < 0) throw new IpFail('no_button');
  seatRows.sort((a, b) => a.seat - b.seat);
  const byName = new Map(seatRows.map((s) => [s.name, s]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const stackU = new Map(seatRows.map((s) => [s.seat, s.stackU]));

  const commit = new Map<number, number>(seatRows.map((s) => [s.seat, 0]));
  const folded = new Set<number>();
  const deadU = new Map<number, number>(); // dead blind money, never returned
  let streetCommit = new Map<number, number>();
  let level = 0; // highest street commitment
  let pot = 0;
  let street: Street = 'preflop';
  let started = false;
  let voluntary = false;
  let hero: number | null = null;
  let hero_cards: string[] | null = null;
  const board: string[] = [];
  const blinds: Blind[] = [];
  const actions: Action[] = [];
  const pot_by_street: StreetState[] = [];
  const collectedU = new Map<number, number>();
  const showdown: { seat: number; cards: string[] }[] = [];
  let summary = false;
  let rakeU: number | null = null;

  const snapshot = (s: Street) => {
    const stacks: Record<number, number> = {};
    for (const x of seatRows) stacks[x.seat] = bb(x.stackU - (commit.get(x.seat) ?? 0));
    pot_by_street.push({ street: s, pot: bb(pot), stacks });
  };
  const add = (seat: number, amt: number) => {
    commit.set(seat, (commit.get(seat) ?? 0) + amt);
    streetCommit.set(seat, (streetCommit.get(seat) ?? 0) + amt);
    level = Math.max(level, streetCommit.get(seat)!);
    pot += amt;
  };

  for (; i < lines.length; i++) {
    const ln = i + 1;
    const l = lines[i].trim();
    if (!l) continue;
    let m: RegExpExecArray | null;
    if (l.startsWith('***')) {
      if (/^\*\*\* SUMMARY \*\*\*/.test(l)) { summary = true; continue; }
      if (/^\*\*\* HOLE CARDS \*\*\*/.test(l)) {
        if (started || summary) throw new IpFail('bad_structure', ln);
        started = true;
        snapshot('preflop');
        continue;
      }
      m = /^\*\*\* (FLOP|TURN|RIVER) \*\*\* \[([^\]]*)\]/.exec(l);
      if (!m || !started || summary) throw new IpFail('bad_structure', ln);
      const want = m[1].toLowerCase() as Street;
      if (ORDER.indexOf(want) !== ORDER.indexOf(street) + 1) throw new IpFail('bad_structure', ln);
      if (want === 'flop') board.push(...cardList(m[2], 3, ln));
      else {
        board.push(...cardList(m[2], 1, ln));
      }
      street = want;
      streetCommit = new Map();
      level = 0;
      snapshot(street);
      continue;
    }
    if (summary) {
      if ((m = /^Total pot (\S+) Rake (\S+)\s*$/.exec(l))) { money(m[1], ln); rakeU = money(m[2], ln); continue; }
      const w = names.find((n) => l.startsWith(n + ': wins '));
      if (w && (m = /^.+?: wins (\S+)\s*$/.exec(l))) {
        const seat = byName.get(w)!.seat;
        collectedU.set(seat, (collectedU.get(seat) ?? 0) + money(m[1], ln));
        continue;
      }
      const sh = names.find((n) => l.startsWith(n + ': Shows [') || l.startsWith(n + ': Mucks ['));
      if (sh && (m = /^.+?: (Shows|Mucks) \[([^\]]*)\]/.exec(l))) {
        const c = cardList(m[2], 2, ln);
        if (m[1] === 'Shows') showdown.push({ seat: byName.get(sh)!.seat, cards: c });
        continue;
      }
      throw new IpFail('bad_structure', ln);
    }
    if ((m = /^Dealt to (.+?) \[([^\]]*)\]\s*$/.exec(l))) {
      const row = byName.get(m[1]);
      if (!row) throw new IpFail('unknown_player', ln);
      if (hero === null && !m[2].includes('?')) {
        hero_cards = cardList(m[2], 2, ln);
        hero = row.seat;
      }
      continue;
    }
    const nm = names.find((n) => l.startsWith(n + ': ') || l.startsWith('Player ') && l.includes('|' + n + ': '));
    if (!nm) throw new IpFail('unknown_player', ln);
    const seat = byName.get(nm)!.seat;
    const a = l.slice(l.indexOf(nm + ': ') + nm.length + 2);

    if ((m = /^Post (SB|BB) (\S+)$/.exec(a))) {
      if (voluntary || street !== 'preflop') throw new IpFail('bad_action', ln);
      const amt = money(m[2], ln);
      // A late joiner posts BB plus the missed SB in one "Post BB": only the BB part is live.
      const dead = m[1] === 'BB' && amt > bbU + EPS ? amt - bbU : 0;
      if (dead > 0) { commit.set(seat, (commit.get(seat) ?? 0) + dead); deadU.set(seat, (deadU.get(seat) ?? 0) + dead); pot += dead; }
      add(seat, amt - dead);
      blinds.push({ seat, kind: dead > 0 ? 'sb+bb' : m[1] === 'SB' ? 'sb' : 'bb', amount: bb(amt) });
      continue;
    }
    if ((m = /^(Shows|Mucks) \[([^\]]*)\]/.exec(a))) {
      if (m[1] === 'Shows') showdown.push({ seat, cards: cardList(m[2], 2, ln) });
      else cardList(m[2], 2, ln);
      continue;
    }

    if (!started) throw new IpFail('bad_structure', ln);
    if (folded.has(seat)) throw new IpFail('bad_action', ln);
    voluntary = true;
    const cur = streetCommit.get(seat) ?? 0;
    const stack = stackU.get(seat)!;
    let kind: ActionKind;
    let to: number | null = null;
    let allin = false;
    if (a === 'Fold') { kind = 'fold'; folded.add(seat); }
    else if (a === 'Check') {
      if (cur < level - EPS) throw new IpFail('bad_action', ln);
      kind = 'check';
    } else if ((m = /^Call (\S+)$/.exec(a))) {
      kind = 'call';
      const amt = money(m[1], ln);
      if (level - cur <= EPS || amt > level - cur + EPS) throw new IpFail('bad_amount', ln);
      add(seat, amt);
      to = cur + amt;
      if (to < level - EPS && (commit.get(seat) ?? 0) < stack - EPS) throw new IpFail('bad_amount', ln); // short call must be all-in
    } else if ((m = /^(Bet|Raise(?: \([^)]*\))?) (\S+)$/.exec(a))) {
      const total = money(m[2], ln);
      if (total <= level + EPS || total <= cur) throw new IpFail('bad_amount', ln);
      kind = m[1] === 'Bet' ? 'bet' : 'raise';
      if (kind === 'bet' && level > EPS) throw new IpFail('bad_action', ln);
      add(seat, total - cur);
      to = total;
    } else if ((m = /^Allin (\S+)$/.exec(a))) {
      const amt = money(m[1], ln);
      if (amt <= 0) throw new IpFail('bad_amount', ln);
      to = cur + amt;
      kind = to > level + EPS ? 'allin' : 'call';
      add(seat, amt);
      allin = true;
    } else throw new IpFail('bad_action', ln);
    const total = commit.get(seat) ?? 0;
    if (total > stack + EPS) throw new IpFail('stack_overflow', ln);
    allin = allin || (kind !== 'fold' && kind !== 'check' && total >= stack - EPS);
    if (allin && (kind === 'bet' || kind === 'raise')) kind = 'allin';
    actions.push({ street, seat, kind, amount_to: to === null ? null : bb(to), allin });
  }

  if (!started || !summary || rakeU === null) throw new IpFail('truncated');
  if (blinds.every((b) => b.kind !== 'bb')) throw new IpFail('no_blinds');
  if (collectedU.size === 0) throw new IpFail('truncated');
  const all = [...(hero_cards ?? []), ...board, ...showdown.filter((x) => x.seat !== hero).flatMap((x) => x.cards)];
  if (new Set(all).size !== all.length) throw new IpFail('duplicate_card');

  // Uncalled bet: the largest total contribution beyond the second largest is returned (not printed).
  const returned: { seat: number; amount: number }[] = [];
  const sorted = [...commit.entries()].map(([k, v]): [number, number] => [k, v - (deadU.get(k) ?? 0)]).sort((x, y) => y[1] - x[1]);
  const over = sorted[0][1] - sorted[1][1];
  if (over > 1e-9) {
    commit.set(sorted[0][0], commit.get(sorted[0][0])! - over);
    pot -= over;
    returned.push({ seat: sorted[0][0], amount: bb(over) });
  }
  let got = 0;
  for (const v of collectedU.values()) got += v;
  if (Math.abs(got + rakeU - pot) > EPS) throw new IpFail('pot_mismatch');

  const warnings: WarningCode[] = [];
  if (hero === null) warnings.push('no_hero');
  const live = seatRows.filter((s) => !folded.has(s.seat) && (commit.get(s.seat) ?? 0) > 0);
  if (live.length >= 3) {
    const c0 = commit.get(live[0].seat)!;
    if (live.some((s) => Math.abs(commit.get(s.seat)! - c0) > EPS)) warnings.push('side_pots');
  }

  const seats: Seat[] = seatRows.map((s) => ({
    seat: s.seat, name: s.name, name_hash: null, stack: bb(s.stackU), is_hero: s.seat === hero,
  }));
  const contributions: Record<number, number> = {};
  const collected: Record<number, number> = {};
  const final_stacks: Record<number, number> = {};
  for (const s of seatRows) {
    const c = commit.get(s.seat)!;
    contributions[s.seat] = bb(c);
    const g = collectedU.get(s.seat) ?? 0;
    if (g) collected[s.seat] = bb(g);
    final_stacks[s.seat] = bb(s.stackU - c + g);
  }
  return {
    hand: {
      site, hand_id, played_at, stakes: { sb: sbU, bb: bbU }, button, hero, seats, hero_cards, board,
      blinds, actions, pot_by_street, returned, contributions, final_pot: bb(pot), collected, final_stacks,
      went_to_showdown: showdown.length > 0, showdown,
    },
    warnings,
  };
}
