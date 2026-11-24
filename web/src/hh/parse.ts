import type {
  Action, ActionKind, Blind, Hand, ParseResult, ParseSummary, ReasonCode, Seat, Site, Street, StreetState, WarningCode,
} from './types';

class Fail extends Error {
  constructor(public reason: ReasonCode, public line?: number) { super(reason); }
}

const HEADER_LIKE = /^(?:\S+ ){0,3}(?:Hand|Game) #\S+:/;
const HEADER = /^(PokerStars(?: Zoom)? Hand|Poker Hand|GGPoker Hand) #([A-Za-z]*\d+):\s*(.*)$/;
const CARD = /^[2-9TJQKA][cdhs]$/;
const EPS = 0.011; // one cent of rounding slack (GG rounds amounts)
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Parse pasted text containing zero or more hands. Never throws. */
export function parseHistory(text: string): ParseSummary {
  const results: ParseResult[] = [];
  try {
    const chunks = split(String(text ?? ''));
    chunks.forEach((lines, index) => results.push(parseChunk(lines, index)));
  } catch {
    results.push({ ok: false, index: results.length, reason: 'bad_structure' });
  }
  const counts: Record<string, number> = {};
  for (const x of results) {
    const k = x.ok ? 'ok' : x.reason;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return { results, counts };
}

/** Parse a single hand's text (first hand if several). */
export function parseHand(text: string): ParseResult {
  return parseHistory(text).results[0] ?? { ok: false, index: 0, reason: 'unsupported_format' };
}

function split(text: string): string[][] {
  const chunks: string[][] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let cur: string[] | null = null;
  let prevBlank = true;
  let junk = false;
  for (const line of lines) {
    const blank = line.trim() === '' || (!cur && /^SYNTHETIC\b/.test(line));
    if (prevBlank && !blank && HEADER_LIKE.test(line)) {
      cur = [line];
      chunks.push(cur);
      junk = false;
    } else if (cur) {
      cur.push(line);
    } else if (!blank && !junk) {
      chunks.push([line]); // garbage before any header
      junk = true;
    }
    prevBlank = blank;
  }
  return chunks;
}

function parseChunk(lines: string[], index: number): ParseResult {
  const info: { site?: Site; hand_id?: string } = {};
  try {
    const { hand, warnings } = build(lines, info);
    return { ok: true, index, hand, warnings };
  } catch (e) {
    const reason: ReasonCode = e instanceof Fail ? e.reason : 'bad_structure';
    const res: ParseResult = { ok: false, index, reason, ...info };
    if (e instanceof Fail && e.line !== undefined) res.line = e.line;
    return res;
  }
}

function money(s: string, line: number): number {
  const t = s.replace(/[$€£,]/g, '');
  if (!/^\d*\.?\d+$/.test(t)) throw new Fail('bad_amount', line);
  return parseFloat(t);
}

function build(lines: string[], info: { site?: Site; hand_id?: string }): { hand: Hand; warnings: WarningCode[] } {
  const head = HEADER.exec(lines[0].trim());
  if (!head) throw new Fail('unsupported_format', 1);
  const site: Site = head[1].startsWith('PokerStars') ? 'pokerstars' : 'ggpoker';
  const hand_id = head[2];
  info.site = site;
  info.hand_id = hand_id;
  const rest = head[3];
  if (/Tournament #|\bLevel\b/i.test(rest) || /^TM/.test(hand_id)) throw new Fail('tournament', 1);
  if (/Omaha|Razz|Stud|Draw|Short/i.test(rest) || !/Hold'em No Limit/.test(rest)) throw new Fail('unsupported_game', 1);
  const st = /\(([^/()]+)\/([^()\s]+)(?:\s+[A-Z]{3})?\)/.exec(rest);
  if (!st) throw new Fail('bad_header', 1);
  const sbU = money(st[1].trim(), 1);
  const bbU = money(st[2].trim(), 1);
  if (!(bbU > 0) || sbU > bbU) throw new Fail('bad_header', 1);
  const dt = /(\d{4})\/(\d\d)\/(\d\d) (\d\d:\d\d:\d\d)/.exec(rest);
  const played_at = dt ? `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}` : null;
  const bb = (x: number) => r4(x / bbU);

  // Seats and table
  let button = -1;
  const seatRows: { seat: number; name: string; stackU: number }[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const t = /^Table '.*' .*Seat #(\d+) is the button/.exec(l);
    if (t) { button = +t[1]; continue; }
    const s = /^Seat (\d+): (.+?) \(([^)]*?) in chips\)/.exec(l);
    if (s) {
      if (seatRows.some((x) => x.seat === +s[1])) throw new Fail('bad_structure', i + 1);
      seatRows.push({ seat: +s[1], name: s[2], stackU: money(s[3].trim(), i + 1) });
      continue;
    }
    break;
  }
  if (seatRows.length < 2) throw new Fail('no_seats');
  if (button < 0) throw new Fail('no_button');
  seatRows.sort((a, b) => a.seat - b.seat);
  const byName = new Map(seatRows.map((s) => [s.name, s]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const stackU = new Map(seatRows.map((s) => [s.seat, s.stackU]));

  const commit = new Map<number, number>(seatRows.map((s) => [s.seat, 0]));
  const folded = new Set<number>();
  let streetCommit = new Map<number, number>();
  let pot = 0;
  let street: Street = 'preflop';
  let started = false; // HOLE CARDS seen
  let voluntary = false;
  let hero: number | null = null;
  let hero_cards: string[] | null = null;
  const board: string[] = [];
  const blinds: Blind[] = [];
  const actions: Action[] = [];
  const pot_by_street: StreetState[] = [];
  const returned: { seat: number; amount: number }[] = [];
  const collectedU = new Map<number, number>();
  const showdown: { seat: number; cards: string[] }[] = [];
  let went_to_showdown = false;
  let summary = false;

  const snapshot = (s: Street) => {
    const stacks: Record<number, number> = {};
    for (const x of seatRows) stacks[x.seat] = bb(x.stackU - (commit.get(x.seat) ?? 0));
    pot_by_street.push({ street: s, pot: bb(pot), stacks });
  };
  const cards = (s: string, n: number, ln: number): string[] => {
    const c = s.trim().split(/\s+/);
    if (c.length !== n || !c.every((x) => CARD.test(x))) throw new Fail('bad_card', ln);
    return c;
  };
  const add = (seat: number, amt: number, toStreet: boolean) => {
    commit.set(seat, (commit.get(seat) ?? 0) + amt);
    if (toStreet) streetCommit.set(seat, (streetCommit.get(seat) ?? 0) + amt);
    pot += amt;
  };

  for (; i < lines.length && !summary; i++) {
    const ln = i + 1;
    const l = lines[i].trim();
    if (!l) continue;
    let m: RegExpExecArray | null;
    if (l.startsWith('***')) {
      if (/\*\*\* (FIRST|SECOND|THIRD) /.test(l)) throw new Fail('run_it_twice', ln);
      if (/^\*\*\* SUMMARY \*\*\*/.test(l)) { summary = true; continue; }
      if (/^\*\*\* HOLE CARDS \*\*\*/.test(l)) {
        if (started) throw new Fail('bad_structure', ln);
        started = true;
        snapshot('preflop');
        continue;
      }
      if (/^\*\*\* SHOW ?DOWN \*\*\*/.test(l)) { went_to_showdown = true; continue; }
      m = /^\*\*\* (FLOP|TURN|RIVER) \*\*\* (\[[^\]]*\](?: \[[^\]]*\])?)/.exec(l);
      if (!m || !started) throw new Fail('bad_structure', ln);
      const want: Street = m[1].toLowerCase() as Street;
      const order: Street[] = ['preflop', 'flop', 'turn', 'river'];
      if (order.indexOf(want) !== order.indexOf(street) + 1) throw new Fail('bad_structure', ln);
      const br = [...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]);
      if (want === 'flop') { if (br.length !== 1) throw new Fail('bad_structure', ln); board.push(...cards(br[0], 3, ln)); }
      else { if (br.length !== 2) throw new Fail('bad_structure', ln); board.push(...cards(br[1], 1, ln)); }
      street = want;
      streetCommit = new Map();
      snapshot(street);
      continue;
    }
    if ((m = /^Dealt to (.+?)(?: \[([^\]]*)\])?\s*$/.exec(l))) {
      const row = byName.get(m[1]);
      if (!row) throw new Fail('unknown_player', ln);
      const inner = m[2]?.trim();
      if (inner && hero === null && !/^[*xX?\s]+$/.test(inner)) {
        hero_cards = cards(inner, 2, ln);
        hero = row.seat;
      }
      continue;
    }
    if ((m = /^Uncalled bet \(([^)]*)\) returned to (.+)$/.exec(l))) {
      const row = byName.get(m[2]);
      if (!row) throw new Fail('unknown_player', ln);
      const a = money(m[1].trim(), ln);
      if (a > (commit.get(row.seat) ?? 0) + 1e-9) throw new Fail('pot_mismatch', ln);
      add(row.seat, -a, false);
      streetCommit.set(row.seat, (streetCommit.get(row.seat) ?? 0) - a);
      returned.push({ seat: row.seat, amount: bb(a) });
      continue;
    }
    const nm = names.find((n) => l.startsWith(n + ': ') || l.startsWith(n + ' collected ') || l.startsWith(n + ' said'));
    if (!nm) continue; // system / chat lines
    const seat = byName.get(nm)!.seat;
    if ((m = /^.+? collected (\S+) from (?:main |side )?pot/.exec(l)) && l.startsWith(nm + ' collected ')) {
      collectedU.set(seat, (collectedU.get(seat) ?? 0) + money(m[1], ln));
      continue;
    }
    if (!l.startsWith(nm + ': ')) continue; // chat
    const a = l.slice(nm.length + 2);

    if ((m = /^posts (?:(the ante|small blind|big blind|small & big blinds) )?(\S+?)( and is all-in)?$/.exec(a))) {
      if (voluntary || street !== 'preflop') throw new Fail('bad_action', ln);
      const amt = money(m[2], ln);
      const kind: Blind['kind'] = ({ 'the ante': 'ante', 'small blind': 'sb', 'big blind': 'bb', 'small & big blinds': 'sb+bb' } as Record<string, Blind['kind']>)[m[1] ?? ''] ?? 'post';
      add(seat, amt, kind !== 'ante');
      blinds.push({ seat, kind, amount: bb(amt) });
      continue;
    }
    if (/^(is sitting out|is disconnected|is connected|has timed out|has returned|will be allowed to play after the button|doesn't show hand|mucks hand|(?:does not )?shows? hand)\b/.test(a) || /^said\b/.test(a)) continue;
    if ((m = /^shows \[([^\]]*)\]/.exec(a))) {
      showdown.push({ seat, cards: cards(m[1], 2, ln) });
      continue;
    }

    // betting actions
    if (!started) throw new Fail('bad_structure', ln);
    if (folded.has(seat)) throw new Fail('bad_action', ln);
    voluntary = true;
    const cur = streetCommit.get(seat) ?? 0;
    let kind: ActionKind;
    let allinSuffix = false;
    let to: number | null = null;
    if (/^folds\b/.test(a)) { kind = 'fold'; folded.add(seat); }
    else if (/^checks$/.test(a)) kind = 'check';
    else if ((m = /^calls (\S+?)( and is all-in)?$/.exec(a))) {
      kind = 'call'; allinSuffix = !!m[2];
      const amt = money(m[1], ln);
      add(seat, amt, true);
      to = cur + amt;
    } else if ((m = /^bets (\S+?)( and is all-in)?$/.exec(a))) {
      kind = 'bet'; allinSuffix = !!m[2];
      const amt = money(m[1], ln);
      add(seat, amt, true);
      to = cur + amt;
    } else if ((m = /^raises (\S+) to (\S+?)( and is all-in)?$/.exec(a))) {
      kind = 'raise'; allinSuffix = !!m[3];
      const total = money(m[2], ln);
      if (total <= cur) throw new Fail('bad_amount', ln);
      add(seat, total - cur, true);
      to = total;
    } else throw new Fail('bad_action', ln);
    const total = commit.get(seat) ?? 0;
    const stack = stackU.get(seat)!;
    if (total > stack + EPS) throw new Fail('stack_overflow', ln);
    const allin = allinSuffix || (kind !== 'fold' && kind !== 'check' && total >= stack - EPS);
    if (allin && (kind === 'bet' || kind === 'raise')) kind = 'allin';
    actions.push({ street, seat, kind, amount_to: to === null ? null : bb(to), allin });
  }

  if (!started) throw new Fail('truncated');
  if (blinds.every((b) => b.kind !== 'bb' && b.kind !== 'sb+bb')) throw new Fail('no_blinds');
  if (collectedU.size === 0) throw new Fail('truncated');
  const all = [...(hero_cards ?? []), ...board, ...showdown.filter((x) => x.seat !== hero).flatMap((x) => x.cards)];
  if (new Set(all).size !== all.length) throw new Fail('duplicate_card');
  let got = 0;
  for (const v of collectedU.values()) got += v;
  if (got > pot + EPS) throw new Fail('pot_mismatch');

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
      went_to_showdown, showdown,
    },
    warnings,
  };
}
