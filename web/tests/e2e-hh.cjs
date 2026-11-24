// E2E for the hand-history screen against a REAL server (temp DB): register, paste synthetic hands, analyse,
// upload, then check /api/hh/decisions and /api/progress?source=hh in en, es and it. Run `npm run build` first.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const { startServer } = require('./server.cjs');
const PORT = process.env.E2E_HH_PORT || '4598', base = `http://localhost:${PORT}`;

const hu = (id, hero, river) => `PokerStars Hand #${id}:  Hold'em No Limit ($0.50/$1 USD) - 2024/02/01 20:00:00 ET
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
V1: checks
Hero: checks
*** RIVER *** [Kh Qd 7s 4c] [2d]
${river.join('\n')}
`;
const callAir = (id) => hu(id, '5h 3c', ['V1: bets $12', 'Hero: calls $12', '*** SHOW DOWN ***', 'V1: shows [Ah Qc]', 'Hero: shows [5h 3c]', 'V1 collected $36 from pot']);
const foldAir = (id) => hu(id, '5h 3c', ['V1: bets $12', 'Hero: folds', 'Uncalled bet ($12) returned to V1', 'V1 collected $12 from pot']);
const oddSize = (id) => hu(id, '5h 3c', ['V1: bets $7.50', 'Hero: calls $7.50', '*** SHOW DOWN ***', 'V1: shows [Ah Qc]', 'Hero: shows [5h 3c]', 'V1 collected $27 from pot']);
const EN = /\b(Hand|Decisions|Analyse|Upload|approximate|Not analysed|Off-tree|Parse|Overrides)\b/;

(async () => {
  const { srv, base: _b, log: _log } = await startServer(PORT, 'gto-e2e-hh-');
  const out = path.join(__dirname, '..', 'test-artifacts'); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const lang of ['en', 'es', 'it']) {
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { throw e; });
      await page.goto(`${base}/?lang=${lang}`);
      await page.click('[data-nav="hh"]');
      await page.waitForSelector('#hh-disclaimer');
      // not logged in: upload is disabled and nothing was sent
      assert.strictEqual(await page.isDisabled('#hh-upload'), true);
      const text = ['SYNTHETIC - invented data, not a real hand history', '', callAir('9000000010' + lang.charCodeAt(1)), foldAir('9000000020' + lang.charCodeAt(1)), oddSize('9000000030' + lang.charCodeAt(1)),
        "PokerStars Hand #900000000999: Tournament #9000001, $1.00+$0.10 USD Hold'em No Limit - Level I (10/20) - 2024/02/01 12:00:00 ET\nTable '9000001 1' 9-max Seat #1 is the button\nSeat 1: Hero (1500 in chips)\nSeat 2: V1 (1500 in chips)\nHero: posts small blind 10\nV1: posts big blind 20\n*** HOLE CARDS ***\nDealt to Hero [5h 3c]\nHero: folds\nV1 collected 30 from pot"].join('\n\n');
      await page.fill('#hh-text', text);
      await page.click('#hh-parse');
      await page.waitForSelector('#hh-summary');
      assert.strictEqual(await page.getAttribute('#hh-summary', 'data-ok'), '3');
      assert.strictEqual(await page.locator('#hh-hands tr[data-status="analysable"]').count(), 3);
      assert.strictEqual(await page.locator('#hh-hands tr[data-status="rejected"]').count(), 1);
      const t0 = Date.now();
      await page.click('#hh-analyse');
      await page.waitForSelector('#hh-cancel');
      await page.waitForFunction(() => document.getElementById('hh-progress').dataset.phase === 'done', null, { timeout: 180000 });
      console.log(lang, 'analyse ms', Date.now() - t0);
      const rows = page.locator('#hh-results tr[data-street="river"]');
      assert.strictEqual(await rows.count(), 3);
      const ev = {};
      for (let i = 0; i < 3; i++) { const r = rows.nth(i); ev[await r.getAttribute('data-hand')] = [await r.getAttribute('data-status'), await r.getAttribute('data-evloss')]; }
      const vals = Object.values(ev);
      assert.strictEqual(vals.filter((v) => v[0] === 'ok').length, 2);
      assert.strictEqual(vals.filter((v) => v[0] === 'off_tree' && v[1] === '').length, 1);
      assert(Math.max(...vals.filter((v) => v[0] === 'ok').map((v) => +v[1])) > 50, 'call with air should lose a lot');
      assert.strictEqual(await page.locator('#hh-results .badge-approx').count(), 5); // 3 turn checks + 2 river decisions
      const body = await page.innerText('#screen');
      if (lang !== 'en') assert(!EN.test(body), `${lang} english word: ${body.match(EN)}`);
      assert.strictEqual(await page.isDisabled('#hh-upload'), true); // still logged out
      // register, then upload
      const user = `hh_${lang}_${Date.now() % 100000}`;
      await page.click('#to-auth'); await page.fill('#u', user); await page.fill('#pw', 'correct-horse-9'); await page.click('#do-register');
      await page.waitForSelector('#whoami');
      await page.click('[data-nav="hh"]');
      await page.waitForSelector('#hh-results');
      assert.strictEqual(await page.locator('#hh-results tr[data-street="river"]').count(), 3); // analysis survives login
      assert.strictEqual(await page.isDisabled('#hh-upload'), false);
      await page.click('#hh-upload');
      await page.waitForFunction(() => document.getElementById('hh-upload-msg').dataset.saved === '1' || document.getElementById('hh-upload-err').textContent, null, { timeout: 30000 });
      assert.strictEqual(await page.innerText('#hh-upload-err'), '');
      await page.screenshot({ path: `${out}/hh-${lang}.png`, fullPage: true });
      // what the server stored
      const j = (u) => page.evaluate(async (x) => (await fetch(x)).json(), u);
      const decs = await j('/api/hh/decisions?limit=200');
      const river = decs.decisions.filter((d) => d.street === 'river');
      assert.strictEqual(river.length, 3);
      assert.strictEqual(river.filter((d) => d.status === 'ok').length, 2);
      assert.strictEqual(river.filter((d) => d.status === 'off_tree' && d.evLoss === null).length, 1);
      assert(river.every((d) => d.rangePreset === 'srp:BTN-BB'));
      assert(decs.decisions.some((d) => d.status === 'unsupported' && d.reason === 'flop'));
      const hh = await j('/api/progress?source=hh');
      assert.strictEqual(hh.source, 'hh');
      assert.strictEqual(hh.total, 5); // 3 turn + 2 river ok decisions
      assert(hh.meanEvLoss > 20, 'mean ev loss ' + hh.meanEvLoss);
      const drills = await j('/api/progress');
      assert.strictEqual(drills.total, 0); // never mixed with drills
      const hands = await j('/api/hh');
      assert.strictEqual(hands.total, 3);
      assert(!JSON.stringify(await j('/api/hh/' + hands.hands[0].id)).match(/Hero|V1/), 'plaintext name leaked');
      console.log(lang, 'OK uploaded decisions', decs.total, 'hh progress', JSON.stringify({ total: hh.total, mean: hh.meanEvLoss, byStatus: hh.byStatus }));
      await ctx.close();
    }
  } finally { await browser.close(); srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
