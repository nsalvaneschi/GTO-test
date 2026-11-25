// Mobile layout e2e against the REAL server (temp DB): on every tab at phone width the page must not scroll
// horizontally. Screenshots go to test-artifacts/mobile-*.png. Prints "OK mobile <device> <lang>" and "E2E MOBILE OK".
// Run `npm run build` first. Hand data is SYNTHETIC.
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const { startServer } = require('./server.cjs');
const PORT = process.env.E2E_MOBILE_PORT || '4596';
const hand = (id) => `PokerStars Hand #${id}:  Hold'em No Limit ($0.50/$1 USD) - 2024/02/01 20:00:00 ET
Table 'Synth I' 2-max Seat #1 is the button
Seat 1: Hero ($100 in chips)
Seat 2: V1 ($100 in chips)
Hero: posts small blind $0.50
V1: posts big blind $1
*** HOLE CARDS ***
Dealt to Hero [5h 3c]
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
V1: bets $12
Hero: folds
Uncalled bet ($12) returned to V1
V1 collected $12 from pot
`;
const RUNS = [['iPhone 13', 'it'], ['Galaxy S5', 'it'], ['iPhone 13', 'en']];
(async () => {
  const { srv, base } = await startServer(PORT, 'gto-e2e-mobile-');
  const out = path.join(__dirname, '..', 'test-artifacts'); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [dev, lang] of RUNS) {
      assert(devices[dev], 'unknown device ' + dev);
      const ctx = await browser.newContext({ ...devices[dev] });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { throw e; });
      const tag = dev.replace(/\W/g, '') + '-' + lang;
      const bad = [];
      const check = async (name) => {
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        await page.screenshot({ path: `${out}/mobile-${tag}-${name}.png`, fullPage: true });
        if (m.sw > m.iw) bad.push(`${name}: scrollWidth ${m.sw} > innerWidth ${m.iw}`);
      };
      await page.goto(`${base}/?lang=${lang}`);
      assert(await page.evaluate(() => !!document.querySelector('meta[name=viewport]')));
      await check('solver-empty');
      await page.fill('#pot', '10'); await page.click('#solve');
      await page.waitForFunction(() => !document.getElementById('solve').disabled, null, { timeout: 120000 });
      await page.waitForSelector('#grid .c[data-hand="AKs"]');
      await check('solver');
      await page.click('#to-auth'); await check('login');
      await page.fill('#u', `m_${lang}_${Date.now() % 100000}`); await page.fill('#pw', 'correct-horse-9'); await page.click('#do-register');
      await page.waitForSelector('#whoami'); await check('registered');
      await page.click('[data-nav="drill"]'); await check('drill-idle');
      for (const street of ['river', 'turn']) {
        await page.selectOption('#street', street);
        await page.click('#start');
        await page.waitForSelector('#acts button[data-a]', { timeout: 240000 });
        await check(`drill-${street}`);
        await page.click('#acts button[data-a]');
        await page.waitForSelector('#result'); await check(`drill-${street}-result`);
        if (street === 'river') { await page.click('[data-nav="solver"]'); await page.click('#solve'); await page.waitForFunction(() => !document.getElementById('solve').disabled, null, { timeout: 120000 }); await page.click('[data-nav="drill"]'); } // a solver run resets the drill to idle
      }
      await page.click('[data-nav="preflop3"]'); await page.waitForSelector('#p3-empty'); await check('preflop3-empty');
      assert.strictEqual(await page.$eval('#p3-score', (e) => getComputedStyle(e).position), 'fixed');
      await page.click('[data-nav="progress"]'); await page.waitForSelector('#p-total'); await check('progress');
      await page.click('[data-nav="hh"]'); await page.waitForSelector('#hh-disclaimer');
      await page.fill('#hh-text', 'SYNTHETIC - invented data\n\n' + hand('90000077' + lang.charCodeAt(1)));
      await page.click('#hh-parse'); await page.waitForSelector('#hh-summary'); await check('hh-parsed');
      await page.click('#hh-analyse');
      await page.waitForFunction(() => document.getElementById('hh-progress').dataset.phase === 'done', null, { timeout: 280000 });
      await check('hh-results');
      await page.click('#hh-upload');
      await page.waitForFunction(() => document.getElementById('hh-upload-msg').dataset.saved === '1', null, { timeout: 30000 });
      await page.click('[data-hhtab="hands"]'); await page.waitForSelector('#hh-list'); await check('hh-list');
      await page.click('[data-open]'); await page.waitForSelector('#rp-step'); for (let k = 0; k < 4; k++) await page.click('#rp-nextdec'); await check('hh-replay');
      await page.click('[data-nav="progress"]'); await page.click('[data-ptab="hh"]'); await page.waitForSelector('#hh-p'); await check('progress-played');
      assert.strictEqual(bad.length, 0, `${tag} horizontal overflow: ${bad.join('; ')}`);
      console.log(`OK mobile ${dev} ${lang}`);
      await ctx.close();
    }
    console.log('E2E MOBILE OK');
  } finally { await browser.close(); srv.kill(); }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
