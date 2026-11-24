// E2E against a REAL server (temp DB): stale solver result vs validation error, hash routing (Back/Forward/reload, Back cancels a
// drill solve), central 401 handling during hand upload (state kept, retry after login), replay focus + keyboard + live region,
// replay stacks for both seats. Run `npm run build` first. Prints one "OK <name>" line per check and "E2E NAV OK" at the end.
const { chromium } = require('playwright');
const assert = require('assert');
const { startServer } = require('./server.cjs');
const PORT = process.env.E2E_NAV_PORT || '4601';
const ok = (name) => console.log('OK ' + name);
// SYNTHETIC hand: hero (button) holds trips, checks the turn, then folds the river to a pot bet.
const HAND = `PokerStars Hand #820000000001:  Hold'em No Limit ($0.50/$1 USD) - 2024/02/01 20:00:00 ET
Table 'Synth I' 2-max Seat #1 is the button
Seat 1: Hero ($100 in chips)
Seat 2: V1 ($100 in chips)
Hero: posts small blind $0.50
V1: posts big blind $1
*** HOLE CARDS ***
Dealt to Hero [Ks Kd]
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
const hash = (page) => new URL(page.url()).hash;
const active = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);
(async () => {
  const { srv, base } = await startServer(PORT, 'gto-e2e-nav-');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { console.error('PAGEERROR at', page.url(), e.stack); throw e; });
    await page.goto(base + '/?lang=en');
    await page.waitForSelector('#solve');

    // 1. a failed validation hides the previous result
    await page.click('#solve');
    await page.waitForFunction(() => !document.getElementById('solve').disabled && document.querySelectorAll('#grid .c').length === 169, null, { timeout: 30000 });
    await page.fill('#board', 'As Kd'); await page.click('#solve');
    assert(await page.textContent('#err'), 'error text expected');
    assert.strictEqual(await page.locator('#grid .c').count(), 0, 'old matrix still visible');
    assert.strictEqual(await page.locator('#expl').count(), 0, 'old exploitability still visible');
    assert.strictEqual(await page.locator('#acts button').count(), 0, 'old actions still visible');
    ok('solver-stale-result-hidden');

    // 2. hash routing
    await page.click('[data-nav="hh"]'); assert.strictEqual(hash(page), '#/hands');
    await page.click('[data-nav="progress"]'); assert.strictEqual(hash(page), '#/progress');
    await page.goBack(); assert.strictEqual(hash(page), '#/hands'); await page.waitForSelector('#hh-disclaimer');
    assert.strictEqual(await page.locator('[data-nav="hh"][aria-current="page"]').count(), 1);
    await page.goBack(); await page.waitForSelector('#solve'); // first entry had no hash: solver
    await page.goForward(); await page.waitForSelector('#hh-disclaimer');
    await page.click('[data-nav="progress"]'); await page.reload();
    await page.waitForSelector('[data-nav="progress"][aria-current="page"]'); assert.strictEqual(hash(page), '#/progress');
    assert(page.url().includes('?lang=en'), 'lang query kept: ' + page.url());
    ok('routing-back-forward-reload');

    // 3. register; leaving a drill mid-solve with Back cancels it
    await page.click('#to-auth');
    const user = `nav${Date.now() % 1e6}`;
    await page.fill('#u', user); await page.fill('#pw', 'correct-horse-9'); await page.click('#do-register');
    await page.waitForSelector('#whoami'); assert.strictEqual(hash(page), '#/practice');
    await page.click('[data-nav="solver"]'); await page.click('[data-nav="drill"]'); assert.strictEqual(hash(page), '#/practice');
    await page.selectOption('#street', 'turn'); await page.click('#start'); await page.waitForSelector('#drill-solving');
    await page.goBack(); await page.waitForSelector('#solve'); assert.strictEqual(await page.locator('#drill-solving').count(), 0);
    await page.goForward(); await page.waitForSelector('#start', { timeout: 5000 }); // cancelled: idle screen, no stuck spinner
    assert.strictEqual(await page.locator('#drill-solving').count(), 0);
    ok('back-cancels-drill-solve');

    // 4. 401 during upload: logged-out UI, data kept, retry after login
    await page.click('[data-nav="hh"]');
    await page.fill('#hh-text', HAND); await page.click('#hh-parse'); await page.waitForSelector('#hh-summary');
    await page.click('#hh-analyse');
    await page.waitForFunction(() => document.getElementById('hh-progress').dataset.phase === 'done', null, { timeout: 120000 });
    const nRes = await page.locator('#hh-results tr[data-hand]').count(); assert(nRes > 0, 'no analysis rows');
    await page.route('**/api/hh', (r) => r.request().method() === 'POST' ? r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }) : r.continue());
    await page.click('#hh-upload');
    await page.waitForSelector('#auth-err[data-code="unauthorized"]');
    assert(/expired/i.test(await page.textContent('#auth-err')), await page.textContent('#auth-err'));
    assert.strictEqual(await page.locator('#whoami').count(), 0); assert.strictEqual(await page.locator('#to-auth').count(), 1);
    await page.unroute('**/api/hh');
    await page.fill('#u', user); await page.fill('#pw', 'correct-horse-9'); await page.click('#do-login');
    await page.waitForSelector('#whoami'); await page.waitForSelector('#hh-results');
    assert.strictEqual(hash(page), '#/hands');
    assert.strictEqual(await page.locator('#hh-results tr[data-hand]').count(), nRes, 'analysis lost');
    assert.strictEqual(await page.getAttribute('#hh-summary', 'data-ok'), '1');
    await page.click('#hh-upload');
    await page.waitForFunction(() => document.getElementById('hh-upload-msg').dataset.saved === '1' || document.getElementById('hh-upload-err').textContent, null, { timeout: 30000 });
    assert.strictEqual(await page.innerText('#hh-upload-err'), ''); assert.strictEqual(await page.getAttribute('#hh-upload-msg', 'data-saved'), '1');
    ok('401-upload-then-retry');

    // 5. replay route survives reload
    await page.click('[data-hhtab="hands"]'); assert.strictEqual(hash(page), '#/hands/list');
    await page.waitForSelector('#hh-list'); await page.click('[data-open]'); await page.waitForSelector('#rp-step');
    assert(/^#\/hands\/\d+$/.test(hash(page)), hash(page));
    const h = hash(page);
    await page.reload(); await page.waitForSelector('#rp-step', { timeout: 10000 }); assert.strictEqual(hash(page), h);
    await page.goBack(); await page.waitForSelector('#hh-list');
    await page.goForward(); await page.waitForSelector('#rp-step');
    ok('replay-route-reload');

    // 6. replay: focus stays on the used control, arrows/Home/End, live region
    const N = +(await page.getAttribute('#rp-step', 'data-total'));
    const step = async () => +(await page.getAttribute('#rp-step', 'data-step'));
    await page.focus('#rp-next'); await page.keyboard.press('Enter');
    assert.strictEqual(await step(), 1); assert.strictEqual(await active(page), 'rp-next');
    await page.keyboard.press('ArrowRight'); assert.strictEqual(await step(), 2); assert.strictEqual(await active(page), 'rp-next');
    assert.strictEqual(await page.textContent('#rp-live'), `Step 2 of ${N}`);
    await page.keyboard.press('ArrowLeft'); assert.strictEqual(await step(), 1);
    await page.focus('#rp-prev'); await page.keyboard.press('Enter'); assert.strictEqual(await step(), 0); // prev becomes disabled
    assert.strictEqual(await active(page), 'rp-ctl', 'focus lost when the used control became disabled');
    await page.keyboard.press('ArrowLeft'); assert.strictEqual(await step(), 0);
    await page.keyboard.press('End'); assert.strictEqual(await step(), N);
    assert.strictEqual(await page.textContent('#rp-live'), `Step ${N} of ${N}`);
    await page.keyboard.press('Home'); assert.strictEqual(await step(), 0);
    await page.focus('#rp-nextdec'); await page.keyboard.press('Enter'); assert.strictEqual(await active(page), 'rp-nextdec');
    await page.focus('[data-goto="3"]'); await page.keyboard.press('Enter'); assert.strictEqual(await step(), 3);
    assert.strictEqual(await page.evaluate(() => document.activeElement.dataset.goto), '3');
    ok('replay-focus-keyboard-live');

    // 7. stacks: both seats when the hero has folded
    await page.focus('#rp-ctl'); await page.keyboard.press('End');
    assert.strictEqual(await step(), N);
    assert.strictEqual(await page.locator('#rp-stacks tr[data-seat]').count(), 2);
    assert.strictEqual(await page.locator('#rp-stacks tr[data-folded="true"]').count(), 1);
    assert.strictEqual(await page.locator('#rp-stacks tr.hero-row[data-folded="true"]').count(), 1);
    ok('replay-stacks-both-seats');
    console.log('E2E NAV OK');
  } finally { await browser.close(); srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
