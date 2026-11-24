// @ts-nocheck  (uses node fs; web has no @types/node)
// Synthetic hands only (invented here). The EV tests run the real WASM engine through LocalBackend.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSync, Solver } from '../src/wasm/gto_wasm.js';
import { parseHand } from '../src/hh/parse';
import { analyzeHand, classify } from '../src/hh/analyze';
import { LocalBackend } from '../src/hh/backend';
import { mapLine, STD_SIZES } from '../src/hh/sizes';
import { toServerHand } from '../src/hh/upload';
import { locales } from '../src/i18n';

initSync({ module: readFileSync(join(__dirname, '../src/wasm/gto_wasm_bg.wasm')) });
const newBackend = () => new LocalBackend((c) => new Solver(c));

/** Synthetic heads-up SRP (Hero button/SB opens, V1 BB calls, flop bet-call, turn check-check). River lines are free text. */
function hu(id: string, board: string, hero: string, river: string[]) {
  const b = board.split(' ');
  const flop = b.slice(0, 3).join(' ');
  return `SYNTHETIC - invented data, not a real hand history
PokerStars Hand #${id}:  Hold'em No Limit ($0.50/$1 USD) - 2024/02/01 20:00:00 ET
Table 'Synth I' 2-max Seat #1 is the button
Seat 1: Hero ($100 in chips)
Seat 2: V1 ($100 in chips)
Hero: posts small blind $0.50
V1: posts big blind $1
*** HOLE CARDS ***
Dealt to Hero [${hero}]
Hero: raises $2 to $3
V1: calls $2
*** FLOP *** [${flop}]
V1: checks
Hero: bets $3
V1: calls $3
*** TURN *** [${flop}] [${b[3]}]
V1: checks
Hero: checks
*** RIVER *** [${flop} ${b[3]}] [${b[4]}]
${river.join('\n')}
`;
}

const parse = (t: string) => { const r = parseHand(t); if (!r.ok) throw new Error(r.reason); return r.hand; };
const vBet = (amt: string) => [`V1: bets $${amt}`];
const show = (v: string, h: string, win: 'V1' | 'Hero', pot: string) => ['*** SHOW DOWN ***', `V1: shows [${v}]`, `Hero: shows [${h}]`, `${win} collected $${pot} from pot`];
const BOARD = 'Kh Qd 7s 4c 2d';
const river = async (id: string, hero: string, l: string[], be = newBackend()) =>
  (await analyzeHand(parse(hu(id, BOARD, hero, l)), { backend: be })).filter((x) => x.street === 'river');
const callPot = (hero: string, win: 'V1' | 'Hero') => [...vBet('12'), 'Hero: calls $12', ...show('Ah Qc', hero, win, '36')];
const foldTo = (amt: string) => [...vBet(amt), 'Hero: folds', `Uncalled bet ($${amt}) returned to V1`, 'V1 collected $12 from pot'];

describe('classifier reason codes', () => {
  const reasons = (h: any) => classify(h).map((c) => [c.street, c.reason]);
  test('HU SRP river is a candidate; earlier streets carry reasons', () => {
    expect(reasons(parse(hu('1', BOARD, '5h 3c', callPot('5h 3c', 'V1'))))).toEqual([['preflop', 'preflop'], ['flop', 'flop'], ['turn', 'turn_not_yet'], ['river', null]]);
  });
  test('multiway river', () => {
    const t = `SYNTHETIC - invented data, not a real hand history
PokerStars Hand #900000000201:  Hold'em No Limit ($0.50/$1 USD) - 2024/02/01 20:00:00 ET
Table 'Synth III' 3-max Seat #1 is the button
Seat 1: Hero ($100 in chips)
Seat 2: V1 ($100 in chips)
Seat 3: V2 ($100 in chips)
V1: posts small blind $0.50
V2: posts big blind $1
*** HOLE CARDS ***
Dealt to Hero [5h 3c]
Hero: raises $2 to $3
V1: calls $2.50
V2: calls $2
*** FLOP *** [Kh Qd 7s]
V1: checks
V2: checks
Hero: checks
*** TURN *** [Kh Qd 7s] [4c]
V1: checks
V2: checks
Hero: checks
*** RIVER *** [Kh Qd 7s 4c] [2d]
V1: checks
V2: checks
Hero: bets $9
V1: folds
V2: folds
Uncalled bet ($9) returned to Hero
Hero collected $9 from pot
`;
    expect(reasons(parse(t)).at(-1)).toEqual(['river', 'multiway']);
  });
  test('no hero, hero cards unknown, no decision, allin preflop', () => {
    const h = parse(hu('2', BOARD, '5h 3c', callPot('5h 3c', 'V1')));
    expect(classify({ ...h, hero: null })).toMatchObject([{ reason: 'no_hero' }]);
    expect(classify({ ...h, hero_cards: null }).at(-1)!.reason).toBe('hero_cards_unknown');
    expect(classify({ ...h, actions: h.actions.filter((a) => a.seat !== h.hero) })).toMatchObject([{ reason: 'no_hero_decision' }]);
    expect(classify({ ...h, actions: h.actions.map((a, i) => (i === 0 ? { ...a, allin: true } : a)) })[0].reason).toBe('allin_preflop');
  });
  test('limp pot has no preset and gets no EV', async () => {
    const txt = readFileSync(join(__dirname, '../src/hh/fixtures/ps_limp_pot.txt'), 'utf8');
    const res = (await analyzeHand(parse(txt), { backend: newBackend() })).filter((x) => x.street === 'river');
    expect(res).toMatchObject([{ status: 'unsupported', reason: 'no_preset', evLoss: null, solverFreqs: null }]);
  });
  test('multiway hand gives no EV at all', async () => {
    const txt = readFileSync(join(__dirname, '../src/hh/fixtures/ps_multiway_3bp.txt'), 'utf8');
    const res = await analyzeHand(parse(txt), { backend: newBackend() });
    expect(res.every((r) => r.evLoss === null && r.solverFreqs === null && r.status === 'unsupported')).toBe(true);
  });
});

describe('size mapping', () => {
  const base = { pot: 12, stack: 94, cap: 2 };
  const bet = (frac: number) => [{ player: 0 as const, kind: 'bet' as const, to: 12 * frac }];
  test('within 5% merges into the menu and records the delta', () => {
    const r = mapLine(bet(0.54), base);
    expect(r.ok && r.sizes).toEqual(STD_SIZES);
    expect(r.ok && r.steps[0].delta).toBeCloseTo(0.04, 6);
  });
  test('5-10% adds the observed size to the menu', () => {
    const r = mapLine(bet(0.56), base);
    expect(r.ok && r.sizes).toEqual([0.33, 0.5, 0.56, 0.75, 1]);
  });
  test('exactly 10% of pot from the menu is in, just over is off-tree', () => {
    const inn = mapLine(bet(0.6), base);
    expect(inn.ok && inn.sizes.some((s) => Math.abs(s - 0.6) < 1e-9)).toBe(true);
    expect(mapLine(bet(0.6001), base)).toEqual({ ok: false, reason: 'size' });
    expect(mapLine(bet(0.62), base)).toEqual({ ok: false, reason: 'size' });
    expect(mapLine(bet(1.1), base).ok).toBe(true);
    expect(mapLine(bet(1.1001), base).ok).toBe(false);
  });
  test('all-in is always representable; raise beyond the cap is not', () => {
    expect(mapLine([{ player: 0, kind: 'allin', to: 94 }], base).ok).toBe(true);
    const l = (k: 'bet' | 'raise', p: 0 | 1, to: number) => ({ player: p, kind: k, to });
    expect(mapLine([l('bet', 0, 6), l('raise', 1, 24), l('raise', 0, 60)], base)).toEqual({ ok: false, reason: 'raise_cap' });
  });
  test('analysis: an odd villain size is off_tree with no EV', async () => {
    const res = await river('3', '5h 3c', [...vBet('7.50'), 'Hero: calls $7.50', ...show('Ah Kc', '5h 3c', 'V1', '27')]);
    expect(res).toMatchObject([{ status: 'off_tree', reason: 'off_tree', evLoss: null, solverFreqs: null }]);
  });
});

describe('river EV loss (real WASM solve)', () => {
  const be = newBackend();
  test('calling a pot bet with air is clearly -EV, folding it is not', async () => {
    const [bad] = await river('10', '5h 3c', callPot('5h 3c', 'V1'), be);
    const [good] = await river('11', '5h 3c', foldTo('12'), be);
    console.log('call air evLoss', bad.evLoss, 'fold air', good.evLoss, 'solve ms', bad.meta!.solveMs, 'expl', bad.meta!.expl);
    expect(bad.status).toBe('ok');
    expect(bad.evLoss!).toBeGreaterThan(50);
    expect(good.evLoss!).toBeLessThan(1);
    expect(bad.solverFreqs!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
    expect(bad.rangePreset).toBe('srp:BTN-BB');
    expect(bad.meta!.expl).toBeLessThan(1);
  });
  test('folding the nuts loses more than calling it; a jam-bluff vs a bet is -EV', async () => {
    const fold = (await river('12', 'Kd Kc', foldTo('12'), be))[0], call = (await river('13', 'Kd Kc', callPot('Kd Kc', 'Hero'), be))[0];
    expect(fold.evLoss!).toBeGreaterThan(call.evLoss!);
    const jam = (await river('14', '5h 3c', [...vBet('12'), 'Hero: raises $82 to $94 and is all-in', 'Uncalled bet ($82) returned to Hero', 'Hero collected $36 from pot'], be))[0];
    expect(jam).toMatchObject({ status: 'ok' });
    expect(jam.evLoss!).toBeGreaterThan(5); // measured about 19% of pot
    expect(jam.meta!.kind).toBe('allin');
  });
  test('identical config hits the solve cache', async () => {
    const [a] = await river('20', '5h 3c', callPot('5h 3c', 'V1'), be);
    const [b] = await river('21', '5h 3c', foldTo('12'), be);
    expect(a.meta!.cached).toBe(true);
    expect(b.meta!.cached).toBe(true);
    expect(b.meta!.solveMs).toBe(0);
    const [c] = await river('22', '6h 3c', foldTo('12'), be); // different hero combo => different ranges => new solve
    expect(c.meta!.cached).toBe(false);
  });
  test('user width override is recorded in the preset name and changes the solve', async () => {
    const h = parse(hu('30', BOARD, '5h 3c', foldTo('12')));
    const res = (await analyzeHand(h, { backend: be, overrides: { width: 0.4 } })).filter((x) => x.street === 'river');
    expect(res[0].rangePreset).toBe('srp:BTN-BB:w40');
    expect(res[0].meta!.cached).toBe(false);
  });
  test('cancel stops a solve', async () => {
    const b2 = newBackend();
    const sig = { aborted: false };
    const p = analyzeHand(parse(hu('40', BOARD, '5h 3c', foldTo('12'))), { backend: b2, signal: sig, onProgress: () => { sig.aborted = true; b2.cancel(); } });
    await expect(p).rejects.toThrow('cancelled');
  });
});

describe('upload adapter and i18n codes', () => {
  test('server schema: hashed names, integer time, numeric pots', async () => {
    const h = parse(hu('50', BOARD, '5h 3c', foldTo('12')));
    const s = await toServerHand(h, 'salt');
    expect(JSON.stringify(s)).not.toMatch(/Hero|V1/);
    expect(s.seats.every((x) => /^[0-9a-f]{64}$/.test(x.name_hash))).toBe(true);
    expect(Number.isInteger(s.played_at) && s.played_at > 1).toBe(true);
    expect(s.pot_by_street.every((x) => typeof x === 'number')).toBe(true);
    expect(s.hero_pos).toBe('BTN');
  });
  test('every status and reason code has en/es/it text', () => {
    const codes = ['multiway', 'preflop', 'allin_preflop', 'flop', 'turn_not_yet', 'no_hero', 'no_hero_decision', 'hero_cards_unknown', 'no_preset', 'range_empty', 'off_tree', 'bad_board', 'solve_failed',
      'unsupported_format', 'tournament', 'unsupported_game', 'run_it_twice', 'bad_header', 'no_seats', 'no_button', 'no_blinds', 'bad_structure', 'bad_card', 'duplicate_card', 'unknown_player', 'bad_action', 'bad_amount', 'stack_overflow', 'pot_mismatch', 'truncated'];
    for (const l of Object.values(locales)) {
      for (const c of codes) expect(l['hh.reason.' + c], c).toBeTruthy();
      for (const s of ['ok', 'off_tree', 'unsupported', 'approx_only']) expect(l['hh.status.' + s], s).toBeTruthy();
      expect(l['hh.disclaimer']).toMatch(/GTO/);
    }
  });
});
