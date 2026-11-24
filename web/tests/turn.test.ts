// @ts-nocheck  (uses node fs; web has no @types/node)
// SYNTHETIC hands only (invented here, fake names Hero/V1). Real WASM engine through LocalBackend.
import { describe, expect, test } from 'vitest';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSync, Solver } from '../src/wasm/gto_wasm.js';
import { parseHand } from '../src/hh/parse';
import { analyzeHand, slowKeys } from '../src/hh/analyze';
import { LocalBackend } from '../src/hh/backend';
import { parseNodePath, replayAt } from '../src/hh/replay';
import { hhQuery } from '../src/api';

initSync({ module: readFileSync(join(__dirname, '../src/wasm/gto_wasm_bg.wasm')) });
let made = 0;
const newBackend = () => new LocalBackend((c) => { made++; return new Solver(c); });
const parse = (t: string) => { const r = parseHand(t); if (!r.ok) throw new Error(r.reason); return r.hand; };
const LOG = process.env.TURN_LOG;

/** SYNTHETIC heads-up SRP: Hero button opens to 3, V1 (BB) calls, flop V1 checks / Hero bets 3 / V1 calls. Pot 12 on the turn, 94 behind. */
function huTurn(id: string, hero: string, turn: string[], river: string[] = []) {
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
*** FLOP *** [Kh Qd 7s]
V1: checks
Hero: bets $3
V1: calls $3
*** TURN *** [Kh Qd 7s] [4c]
${turn.join('\n')}${river.length ? '\n*** RIVER *** [Kh Qd 7s 4c] [2d]\n' + river.join('\n') : ''}
`;
}
const showdown = (v: string, h: string, win: string, pot: string) => ['*** SHOW DOWN ***', `V1: shows [${v}]`, `Hero: shows [${h}]`, `${win} collected $${pot} from pot`];
const turnCall = (hero: string, win: string) => ['V1: bets $12', 'Hero: calls $12', ...showdown('Ah Qc', hero, win, '36')];
const turnFold = ['V1: bets $12', 'Hero: folds', 'Uncalled bet ($12) returned to V1', 'V1 collected $12 from pot'];

describe('turn EV (real WASM solve)', () => {
  const be = newBackend();
  const turnRes = async (id: string, hero: string, lines: string[]) => (await analyzeHand(parse(huTurn(id, hero, lines)), { backend: be })).filter((d) => d.street === 'turn');

  test('overcall with air and overfold of trips have the expected sign', async () => {
    const t0 = Date.now();
    const [callAir] = await turnRes('1', '8h 2c', turnCall('8h 2c', 'V1'));
    const [foldAir] = await turnRes('2', '8h 2c', turnFold);
    const [foldTrips] = await turnRes('3', 'Ks Kd', turnFold);
    const [callTrips] = await turnRes('4', 'Ks Kd', turnCall('Ks Kd', 'Hero'));
    if (LOG) appendFileSync(LOG, `sign test total ms ${Date.now() - t0}; solves ${[callAir, foldAir, foldTrips, callTrips].map((d) => d.meta.solveMs + 'ms/' + d.meta.iters + 'it/expl' + d.meta.expl.toFixed(3) + '/' + d.meta.tier).join(' ')}; evLoss ${[callAir, foldAir, foldTrips, callTrips].map((d) => d.evLoss.toFixed(1)).join(' ')}\n`);
    for (const d of [callAir, foldAir, foldTrips, callTrips]) { expect(d.status).toBe('ok'); expect(d.meta.solve).toBe('turn'); expect(d.rangePreset).toBe('srp:BTN-BB'); }
    expect(callAir.evLoss).toBeGreaterThan(3); // measured about 9.5% of pot
    expect(foldAir.evLoss).toBeLessThan(1);
    expect(foldTrips.evLoss).toBeGreaterThan(callTrips.evLoss + 50); // measured about 269 vs 0
    expect(callAir.solverFreqs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
    expect(parseNodePath(callAir.nodePath).labels.length).toBe(callAir.solverFreqs.length); // every frequency has an action name
  }, 600_000);

  test('the river decision of a turn hand reuses the single turn solve', async () => {
    const be2 = newBackend(); made = 0;
    // turn: V1 bets pot, Hero calls; river: V1 bets half pot (18 into 36), Hero folds.
    const txt = huTurn('5', '8h 2c', ['V1: bets $12', 'Hero: calls $12'], ['V1: bets $18', 'Hero: folds', 'Uncalled bet ($18) returned to V1', 'V1 collected $36 from pot']);
    const res = await analyzeHand(parse(txt), { backend: be2 });
    const t = res.find((d) => d.street === 'turn'), r = res.find((d) => d.street === 'river');
    expect(t.status === 'ok' || t.status === 'approx_only').toBe(true);
    expect(r.evLoss).not.toBeNull();
    expect(r.meta.solve).toBe('turn');
    expect(made).toBe(1); // one solve served both decisions
    expect(r.meta.cached).toBe(true);
    expect(r.nodePath.split('/')[1].split('.').length).toBeGreaterThan(3); // turn actions, the river card, river actions
  }, 600_000);

  test('turn bet 10% off every menu size is off_tree with no EV; the river is then solved alone', async () => {
    const txt = huTurn('6', '8h 2c', ['V1: bets $7.50', 'Hero: calls $7.50'], ['V1: checks', 'Hero: checks', ...showdown('Ah Qc', '8h 2c', 'V1', '27')]);
    const res = await analyzeHand(parse(txt), { backend: newBackend() });
    expect(res.find((d) => d.street === 'turn')).toMatchObject({ status: 'off_tree', reason: 'off_tree', evLoss: null, solverFreqs: null });
    expect(res.find((d) => d.street === 'river').meta?.solve ?? 'river').toBe('river');
  }, 600_000);

  test('a too-slow full-menu solve falls back to the small menu and is flagged approx_only', async () => {
    slowKeys.clear();
    const [d] = (await analyzeHand(parse(huTurn('7', '8h 2c', turnCall('8h 2c', 'V1'))), { backend: newBackend(), turnParams: { target: 0.3, chunk: 10, maxIters: 300, maxMs: 1 } })).filter((x) => x.street === 'turn');
    expect(d).toMatchObject({ status: 'approx_only', reason: 'turn_small_menu' });
    expect(d.meta.tier).toBe('small');
    expect(d.evLoss).toBeGreaterThan(0);
    slowKeys.clear();
  }, 600_000);

  test('multiway turn and flop stay reason-coded with no EV', async () => {
    const t = `SYNTHETIC - invented data, not a real hand history
PokerStars Hand #900000000301:  Hold'em No Limit ($0.50/$1 USD) - 2024/02/01 20:00:00 ET
Table 'Synth III' 3-max Seat #1 is the button
Seat 1: Hero ($100 in chips)
Seat 2: V1 ($100 in chips)
Seat 3: V2 ($100 in chips)
V1: posts small blind $0.50
V2: posts big blind $1
*** HOLE CARDS ***
Dealt to Hero [8h 2c]
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
Hero: bets $9
V1: folds
V2: folds
Uncalled bet ($9) returned to Hero
Hero collected $9 from pot
`;
    const res = await analyzeHand(parse(t), { backend: newBackend() });
    expect(res.map((d) => [d.street, d.reason, d.evLoss])).toEqual([['preflop', 'preflop', null], ['flop', 'flop', null], ['turn', 'multiway', null]]);
  });
});

describe('list filters and replay helpers', () => {
  test('filters build the H2 query string', () => {
    expect(hhQuery({}, 20, 0)).toBe('limit=20&offset=0');
    const q = new URLSearchParams(hhQuery({ site: 'ggpoker', from: '2024-02-01', to: '2024-02-02', status: 'off_tree', street: 'turn', minEvLoss: '5' }, 20, 40));
    expect(Object.fromEntries(q)).toEqual({ limit: '20', offset: '40', site: 'ggpoker', from: '1706745600', to: '1706918399', status: 'off_tree', street: 'turn', minEvLoss: '5' });
    expect(new URLSearchParams(hhQuery({ minEvLoss: '0', from: 'garbage' }, 5, 0)).has('minEvLoss')).toBe(false);
    expect(new URLSearchParams(hhQuery({ from: 'garbage' }, 5, 0)).has('from')).toBe(false);
  });
  test('replay state: board, pot at street start, stacks', () => {
    const h = { site: 'pokerstars', hand_id: '1', stakes: { sb: 0.5, bb: 1 }, seats: [{ seat: 1, stack: 100, is_hero: true }, { seat: 2, stack: 100, is_hero: false }],
      hero_cards: ['5h', '3c'], board: ['Kh', 'Qd', '7s', '4c'], pot_by_street: [1.5, 6, 12],
      actions: [['preflop', 1, 'raise', 3], ['preflop', 2, 'call', 3], ['flop', 2, 'check', null], ['flop', 1, 'bet', 3], ['flop', 2, 'call', 3], ['turn', 2, 'bet', 12]].map(([street, seat, kind, amount_to]) => ({ street, seat, kind, amount_to })) };
    expect(replayAt(h, 0)).toMatchObject({ street: 'preflop', board: [], potStart: 1.5 });
    expect(replayAt(h, 5)).toMatchObject({ street: 'flop', board: ['Kh', 'Qd', '7s'], potStart: 6, stacks: { 1: 94, 2: 94 } });
    expect(replayAt(h, 6)).toMatchObject({ street: 'turn', board: ['Kh', 'Qd', '7s', '4c'], potStart: 12, stacks: { 1: 94, 2: 82 }, inStreet: { 2: 12 } });
  });
  test('node path parsing', () => {
    expect(parseNodePath('a12/0.1/f.c.r50')).toEqual({ actionIndex: 12, path: '0.1', labels: ['f', 'c', 'r50'] });
    expect(parseNodePath('a3')).toEqual({ actionIndex: 3, path: '', labels: [] });
    expect(parseNodePath('hand')).toBeNull();
  });
});
