// E2E (H4) against a REAL server (temp DB): import -> analyse (turn + river) -> upload -> hands list with filters -> replay
// -> progress "Played hands" tab -> delete, in en/es/it. Run `npm run build` first. Hands are SYNTHETIC (invented here).
// Prints "OK hh-replay <lang>" per language and "E2E HH REPLAY OK" at the end; the caller must check those lines.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const { startServer } = require('./server.cjs');
const PORT = process.env.E2E_HH2_PORT || '4597';

const ps = (id, hero, turn, river) => `PokerStars Hand #${id}:  Hold'em No Limit ($0.50/$1 USD) - 2024/02/01 20:00:00 ET
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
${turn.join('\n')}
*** RIVER *** [Kh Qd 7s 4c] [2d]
${river.join('\n')}
`;
const show = (v, h, win, pot) => ['*** SHOW DOWN ***', `V1: shows [${v}]`, `Hero: shows [${h}]`, `${win} collected $${pot} from pot`];
const foldRiver = ['V1: bets $12', 'Hero: folds', 'Uncalled bet ($12) returned to V1', 'V1 collected $12 from pot'];
// A: turn call with air, river check-check. B: trips check, then folds the river to a pot bet (big mistake). D: odd turn size (off-tree).
const A = (id) => ps(id, '8h 2c', ['V1: bets $12', 'Hero: calls $12'], ['V1: checks', 'Hero: checks', ...show('Ah Qc', '8h 2c', 'V1', '36')]);
const B = (id) => ps(id, 'Ks Kd', ['V1: checks', 'Hero: checks'], foldRiver);
const D = (id) => ps(id, '8h 2c', ['V1: bets $7.50', 'Hero: calls $7.50'], ['V1: checks', 'Hero: checks', ...show('Ah Qc', '8h 2c', 'V1', '27')]);
const C = (id) => `Poker Hand #HD${id}: Hold'em No Limit ($0.10/$0.20) - 2024/02/03 18:00:10
Table 'SynthGG1' 2-max Seat #1 is the button
Seat 1: Hero ($20 in chips)
Seat 2: V1 ($20 in chips)
Hero: posts small blind $0.10
V1: posts big blind $0.20
*** HOLE CARDS ***
Dealt to Hero [8h 2c]
Dealt to V1
Hero: raises $0.40 to $0.60
V1: calls $0.40
*** FLOP *** [Kh Qd 7s]
V1: checks
Hero: bets $0.60
V1: calls $0.60
*** TURN *** [Kh Qd 7s] [4c]
V1: checks
Hero: checks
*** RIVER *** [Kh Qd 7s 4c] [2d]
V1: bets $2.40
Hero: folds
Uncalled bet ($2.40) returned to V1
V1 collected $2.40 from pot
`;

(async () => {
  const { srv, base, log } = await startServer(PORT, 'gto-e2e-hh2-');
  const out = path.join(__dirname, '..', 'test-artifacts'); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const seen = [], timings = [];
  try {
    for (const lang of ['en', 'es', 'it']) {
      const T = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', `${lang}.json`), 'utf8'));
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { throw e; });
      const j = (u, method = 'GET') => page.evaluate(async ([x, m]) => (await fetch(x, { method: m })).json(), [u, method]);
      const n = lang.charCodeAt(1);
      await page.goto(`${base}/?lang=${lang}`);
      await page.click('[data-nav="hh"]');
      await page.waitForSelector('#hh-disclaimer');
      await page.fill('#hh-text', ['SYNTHETIC - invented data, not a real hand history', A('90000001' + n), B('90000002' + n), C('90000003' + n), D('90000004' + n)].join('\n\n'));
      await page.click('#hh-parse');
      await page.waitForSelector('#hh-summary');
      assert.strictEqual(await page.getAttribute('#hh-summary', 'data-ok'), '4');
      const t0 = Date.now();
      await page.click('#hh-analyse');
      await page.waitForSelector('#hh-cancel'); // progress + cancel are shown while solving
      await page.waitForFunction(() => document.getElementById('hh-progress').dataset.phase === 'done', null, { timeout: 280000 });
      const analyseMs = Date.now() - t0;
      const rows = page.locator('#hh-results tr');
      const turnRows = page.locator('#hh-results tr[data-street="turn"]');
      assert.strictEqual(await turnRows.count(), 4);
      const st = {};
      for (let i = 0; i < 4; i++) { const r = turnRows.nth(i); st[await r.getAttribute('data-hand')] = [await r.getAttribute('data-status'), await r.getAttribute('data-evloss')]; }
      const vals = Object.values(st);
      assert.strictEqual(vals.filter((v) => v[0] === 'off_tree' && v[1] === '').length, 1, JSON.stringify(st)); // D
      assert(vals.filter((v) => v[0] === 'ok' || v[0] === 'approx_only').length === 3, JSON.stringify(st));
      // frequencies carry action names, never bare percentages
      const solves = await page.$$eval('#hh-results tr[data-cached="false"]', (trs) => trs.map((r) => ({ solve: r.dataset.solve, tier: r.dataset.tier, ms: +r.dataset.solvems })));
      assert(solves.some((x) => x.solve === 'turn'), 'no turn solve ran: ' + JSON.stringify(solves));
      timings.push(...solves.filter((x) => x.solve === 'turn').map((x) => x.ms));
      const freqCells = await page.locator('#hh-results tr[data-street="river"][data-status="ok"] td:last-child').allInnerTexts();
      assert(freqCells.length > 0 && freqCells.every((c) => c.includes(T['action.fold']) || c.includes(T['action.check'])), 'freqs without names: ' + freqCells);
      // register, upload, hands list
      const user = `h4_${lang}_${Date.now() % 100000}`;
      await page.click('#to-auth'); await page.fill('#u', user); await page.fill('#pw', 'correct-horse-9'); await page.click('#do-register');
      await page.waitForSelector('#whoami');
      // progress "Played hands" tab on a fresh account: empty state, drills untouched
      await page.click('[data-nav="progress"]');
      await page.click('[data-ptab="hh"]');
      await page.waitForSelector('#hh-p-empty');
      await page.click('[data-nav="hh"]');
      await page.waitForSelector('#hh-results');
      await page.click('#hh-upload');
      await page.waitForFunction(() => document.getElementById('hh-upload-msg').dataset.saved === '1' || document.getElementById('hh-upload-err').textContent, null, { timeout: 30000 });
      assert.strictEqual(await page.innerText('#hh-upload-err'), '');
      await page.click('[data-hhtab="hands"]');
      await page.waitForSelector('#hh-list');
      assert.strictEqual(await page.getAttribute('#hh-list-count', 'data-total'), '4');
      // filters call the H2 query params
      const filter = async (vals, expectTotal, label) => {
        for (const id of ['site', 'from', 'to', 'status', 'street', 'minEvLoss']) await page.fill(`#f-${id}`, '').catch(() => {});
        for (const id of ['site', 'status', 'street']) await page.selectOption(`#f-${id}`, '');
        for (const [id, v] of Object.entries(vals)) { if (['site', 'status', 'street'].includes(id)) await page.selectOption(`#f-${id}`, v); else await page.fill(`#f-${id}`, v); }
        const req = page.waitForRequest((r) => r.url().includes('/api/hh?') && r.method() === 'GET');
        await page.click('#f-apply');
        const url = new URL((await req).url());
        for (const [id, v] of Object.entries(vals)) if (['site', 'status', 'street'].includes(id)) assert.strictEqual(url.searchParams.get(id), v, label);
        await page.waitForFunction((t) => document.getElementById('hh-list-count')?.dataset.total === String(t), expectTotal, { timeout: 10000 });
        assert.strictEqual(await page.getAttribute('#hh-list-count', 'data-total'), String(expectTotal), label);
        return url;
      };
      await filter({ site: 'ggpoker' }, 1, 'site');
      await filter({ site: 'pokerstars' }, 3, 'site ps');
      await filter({ from: '2024-02-02' }, 1, 'from date');
      assert((await filter({ to: '2024-02-02' }, 3, 'to date')).searchParams.has('to'));
      await filter({ status: 'off_tree' }, 1, 'status off_tree');
      await filter({ street: 'turn', status: 'ok' }, 3, 'street+status');
      await filter({ minEvLoss: '50' }, 1, 'mistakes above 50% pot'); // only B (folds trips on the river)
      await filter({}, 4, 'cleared');
      // replay of B (trips): step to the river fold decision
      await filter({ minEvLoss: '50' }, 1, 'again');
      await page.click('[data-open]');
      await page.waitForSelector('#rp-step');
      assert.strictEqual(await page.getAttribute('#rp-board', 'data-n'), '0');
      let decisions = 0, riverShown = false;
      for (let k = 0; k < 4; k++) {
        await page.click('#rp-nextdec');
        if (await page.locator('#hh-decision').count()) {
          decisions++;
          const d = page.locator('#hh-decision');
          const status = await d.getAttribute('data-status');
          if (await page.getAttribute('#rp-board', 'data-n') === '5') {
            riverShown = true;
            assert.strictEqual(status, 'ok');
            const rowsT = await page.locator('#hh-freqs tr').allInnerTexts();
            assert(rowsT.length >= 2 && rowsT.every((r) => /\d+\s?%/.test(r) && !/^\s*\d/.test(r)), 'rows must start with an action name: ' + rowsT);
            assert(rowsT.some((r) => r.includes(T['action.fold'])) && rowsT.some((r) => r.includes(T['action.call'])), rowsT.join('|'));
            assert(+(await d.getAttribute('data-evloss')) > 50);
            assert.strictEqual(await page.locator('#hh-decision .badge-approx').count(), 1);
            assert((await page.innerText('#hh-assume')).includes('srp:BTN-BB'));
            assert.strictEqual(await page.locator('#hh-freqs tr[data-chosen="true"]').count(), 1);
            assert.strictEqual(await page.getAttribute('#rp-pot', 'data-value'), '12');
            if (lang === 'it') await page.screenshot({ path: `${out}/hh-replay-it.png`, fullPage: true });
            break;
          }
        }
      }
      assert(riverShown && decisions >= 2, 'did not reach the river decision');
      await page.click('#rp-prev'); await page.click('#rp-back');
      await page.waitForSelector('#hh-list');
      // progress: Played hands tab is separate from drills
      const hh = await j('/api/progress?source=hh');
      assert(hh.total >= 5, 'hh total ' + hh.total);
      await page.click('[data-nav="progress"]');
      await page.waitForSelector('#p-empty'); // drill tab: no drill answers
      await page.click('[data-ptab="hh"]');
      await page.waitForSelector('#hh-p-total');
      assert.strictEqual(await page.getAttribute('#hh-p-total', 'data-value'), String(hh.total));
      assert.strictEqual((await j('/api/progress')).total, 0);
      assert((await page.innerText('#hh-prog-note')).length > 40);
      if (lang === 'it') await page.screenshot({ path: `${out}/hh-played-it.png`, fullPage: true });
      // delete my hand histories (confirmation step), then delete my data
      await page.click('[data-nav="hh"]'); await page.click('[data-hhtab="hands"]'); await page.waitForSelector('#hh-list');
      await page.click('#hh-del-hands');
      await page.waitForSelector('#hh-confirm[data-kind="hands"]');
      await page.click('#hh-confirm-no');
      assert.strictEqual((await j('/api/hh')).total, 4); // cancelled: nothing deleted
      await page.click('#hh-del-hands'); await page.click('#hh-confirm-yes');
      await page.waitForSelector('#hh-list-empty');
      assert.strictEqual((await j('/api/hh')).total, 0);
      assert.strictEqual((await j('/api/progress?source=hh')).total, 0);
      assert((await page.innerText('#hh-data-msg')).length > 3);
      await page.click('[data-hhtab="import"]');
      await page.click('#hh-upload');
      await page.waitForFunction(() => document.getElementById('hh-upload-msg').dataset.saved === '1', null, { timeout: 30000 });
      assert.strictEqual((await j('/api/hh')).total, 4);
      await page.click('[data-hhtab="hands"]'); await page.waitForSelector('#hh-list');
      await page.click('#hh-del-all'); await page.waitForSelector('#hh-confirm[data-kind="all"]'); await page.click('#hh-confirm-yes');
      await page.waitForSelector('#hh-list-empty');
      assert.strictEqual((await j('/api/hh')).total, 0);
      const body = await page.innerText('#screen');
      if (lang !== 'en') assert(!/\b(Delete|Mistakes|Replay|Played hands|Step|Pot at)\b/.test(body), `${lang} english word: ${body}`);
      console.log(`OK hh-replay ${lang} analyseMs=${analyseMs} hhTotal=${hh.total} byStatus=${JSON.stringify(hh.byStatus)}`);
      seen.push(lang);
      await ctx.close();
    }
    assert.deepStrictEqual(seen, ['en', 'es', 'it']);
    const q = [...timings].sort((a, b) => a - b);
    console.log(`turn solve wall ms in browser worker (N=${q.length}): p50 ${q[Math.floor(q.length / 2)]} max ${q[q.length - 1]} all ${q.join(',')}`);
    console.log('E2E HH REPLAY OK');
  } catch (e) { console.error(log()); throw e; } finally { await browser.close(); srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
