// Adversarial UI tests against a REAL server (temp DB): bad inputs, double submit, cancel/navigation races, expired
// session, offline, huge pastes, 200-hand analysis, modal keyboard handling, matrix keyboard. Run `npm run build` first.
const { chromium } = require('playwright');
const assert = require('assert');
const { startServer } = require('./server.cjs');
const PORT = process.env.E2E_ADV_PORT || '4600';
const ok = (name) => console.log('OK ' + name);
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
Hero: calls $12
*** SHOW DOWN ***
V1: shows [Ah Qc]
Hero: shows [5h 3c]
V1 collected $36 from pot
`;
let n = 0;
async function register(page, base, lang = 'en') {
  await page.goto(`${base}/?lang=${lang}`);
  await page.click('#to-auth');
  await page.fill('#u', `adv${Date.now() % 1e6}${n++}`); await page.fill('#pw', 'correct-horse-9'); await page.click('#do-register');
  await page.waitForSelector('#whoami');
}
const solverDone = (page) => page.waitForFunction(() => !document.getElementById('solve').disabled, null, { timeout: 30000 });
(async () => {
  const { srv, base } = await startServer(PORT, 'gto-e2e-adv-');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(base + '/');
    await page.waitForSelector('#solve');

    // 1. boards
    const tryBoard = async (b, f = {}) => {
      await page.fill('#board', b);
      for (const [k, v] of Object.entries({ pot: '10', stack: '50', ...f })) await page.fill('#' + k, v);
      await page.click('#solve'); await solverDone(page);
      return { err: await page.textContent('#err'), cells: await page.locator('#grid .c').count() };
    };
    for (const b of ['As As 7c 4h 2s', 'XX', 'As Kd 7c 4h 2s 3c', 'As Kd 7c', '', 'As Kd', '1s Kd 7c 4h 2s']) {
      const r = await tryBoard(b);
      assert(r.err && r.cells === 0, `board ${JSON.stringify(b)} should be rejected: ${JSON.stringify(r)}`);
      assert(!/need 3-5|bad card/.test(r.err), 'engine text must not leak: ' + r.err);
    }
    for (const b of ['as kd 7c 4h 2s', '  As   Kd 7c  4h 2s ', 'AsKd7c4h2s', 'AS KD 7C 4H 2S']) {
      const r = await tryBoard(b); assert(!r.err && r.cells === 169, `board ${JSON.stringify(b)} should solve: ${JSON.stringify(r)}`);
      assert.strictEqual(await page.inputValue('#board'), 'As Kd 7c 4h 2s');
    }
    ok('boards');
    // 2. pot / stack
    for (const f of [{ pot: '0' }, { pot: '-5' }, { pot: '1e300' }, { pot: '' }, { stack: '0' }, { stack: '-1' }, { stack: '1e9' }, { stack: '' }]) {
      const r = await tryBoard('As Kd 7c 4h 2s', f); assert(r.err, `chips ${JSON.stringify(f)}: ${JSON.stringify(r)}`);
    }
    for (const f of [{ pot: '2.5' }, { stack: '2.5' }]) { const r = await tryBoard('As Kd 7c 4h 2s', f); assert(!r.err && r.cells === 169, JSON.stringify(f)); }
    await page.fill('#pot', 'abc').then(() => assert.fail('number input accepted text'), () => {});
    ok('chips');
    // 3. double submit + rapid clicking never leaves the button stuck
    await page.fill('#pot', '10'); await page.fill('#stack', '50');
    await page.dblclick('#solve'); await page.click('#solve', { force: true, timeout: 1000 }).catch(() => {});
    await solverDone(page); assert.strictEqual(await page.locator('#grid .c').count(), 169);
    for (let i = 0; i < 5; i++) { await page.click('#solve'); await page.waitForTimeout(20); }
    await solverDone(page); assert.strictEqual(await page.locator('#grid .c').count(), 169);
    ok('double-submit');
    // 4. language switch + tab switch mid-solve
    await page.click('#solve'); await page.selectOption('#lang', 'es'); await page.click('[data-nav="progress"]'); await page.click('[data-nav="solver"]');
    await solverDone(page); assert.strictEqual(await page.locator('#grid .c').count(), 169);
    assert.strictEqual(await page.locator('#solve').textContent(), 'Resolver');
    await page.selectOption('#lang', 'en');
    ok('lang-tab-switch-mid-solve');
    // 5. matrix keyboard: Enter / Space select the cursor cell
    await page.focus('#grid'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
    assert.strictEqual(await page.locator('#grid .foc').getAttribute('data-ix'), '13');
    assert.strictEqual(await page.locator('#grid .sel').count(), 0);
    await page.keyboard.press('Enter'); assert.strictEqual(await page.locator('#grid .sel').getAttribute('data-ix'), '13');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press(' ');
    assert.strictEqual(await page.locator('#grid .sel').getAttribute('data-ix'), '14'); assert.strictEqual(await page.locator('#grid .sel').count(), 1);
    ok('matrix-keyboard');

    // 6. logged out: login errors, offline, long input
    await page.click('#to-auth');
    await page.fill('#u', 'x'.repeat(10000)); await page.fill('#pw', 'y'.repeat(10000));
    assert((await page.inputValue('#u')).length <= 64 && (await page.inputValue('#pw')).length <= 128);
    await ctx.setOffline(true);
    await page.click('#do-login');
    await page.waitForFunction(() => document.getElementById('auth-err').dataset.code === 'network');
    assert(await page.textContent('#auth-err')); assert(!(await page.locator('#do-login').isDisabled()));
    await ctx.setOffline(false);
    ok('login-offline-long-input');

    // 7. register, reload keeps session
    await register(page, base);
    await page.reload(); await page.waitForSelector('#whoami', { timeout: 5000 });
    ok('reload-keeps-session');

    // 8. HH big / binary / BOM+CRLF pastes
    await page.click('[data-nav="hh"]');
    await page.fill('#hh-text', 'x'.repeat(5_000_000)); await page.click('#hh-parse');
    assert(await page.textContent('#hh-err')); assert.strictEqual(await page.locator('#hh-summary').count(), 0);
    await page.fill('#hh-text', Array.from({ length: 4000 }, (_, i) => String.fromCharCode(i % 256 || 1)).join('')); await page.click('#hh-parse');
    assert.strictEqual(await page.getAttribute('#hh-summary', 'data-ok'), '0');
    await page.fill('#hh-text', '﻿' + hand('800000000001').replace(/\n/g, '\r\n')); await page.click('#hh-parse');
    assert.strictEqual(await page.getAttribute('#hh-summary', 'data-ok'), '1');
    ok('hh-pastes');

    // 9. hh upload while offline -> localized network error, UI still usable
    await page.click('#hh-analyse'); await page.waitForFunction(() => document.getElementById('hh-progress').dataset.phase === 'done', null, { timeout: 60000 });
    await ctx.setOffline(true); await page.click('#hh-upload');
    await page.waitForFunction(() => document.getElementById('hh-upload-err').textContent.length > 0);
    await ctx.setOffline(false); assert(!(await page.locator('#hh-upload').isDisabled()));
    ok('hh-upload-offline');

    // 10. 200 hands: progress shown, UI responsive, cancel works
    await page.evaluate((t) => { const e = document.getElementById('hh-text'); e.value = t; e.dispatchEvent(new Event('input')); }, Array.from({ length: 200 }, (_, i) => hand(String(810000000000 + i))).join('\n\n\n')); await page.click('#hh-parse');
    assert.strictEqual(await page.getAttribute('#hh-summary', 'data-ok'), '200');
    await page.click('#hh-analyse');
    await page.waitForFunction(() => /\b[2-9]\b/.test(document.getElementById('hh-progress').textContent) , null, { timeout: 60000 });
    const lat = await page.evaluate(() => new Promise((res) => { let max = 0, k = 0; const tick = () => { const t = performance.now(); setTimeout(() => { max = Math.max(max, performance.now() - t); if (++k < 20) tick(); else res(max); }, 0); }; tick(); }));
    assert(lat < 500, 'main thread blocked ' + lat + 'ms during 200-hand analysis');
    await page.click('#hh-cancel'); await page.waitForFunction(() => document.getElementById('hh-progress').dataset.phase === 'done', null, { timeout: 30000 });
    assert(!(await page.locator('#hh-analyse').isDisabled()));
    console.log('OK hh-200-cancel (max timer delay ' + (lat | 0) + 'ms)');

    // 11. confirm modal: focus on open, Tab trap, Escape closes and restores focus
    await page.click('[data-hhtab="hands"]'); await page.waitForSelector('#hh-del-hands');
    await page.click('#hh-del-hands');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'hh-confirm-no');
    await page.keyboard.press('Tab'); assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'hh-confirm-yes');
    await page.keyboard.press('Tab'); assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'hh-confirm-no');
    await page.keyboard.press('Shift+Tab'); assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'hh-confirm-yes');
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.locator('#hh-confirm').count(), 0);
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'hh-del-hands');
    ok('modal-keyboard');

    // 12. drill: cancel then start, navigate away mid-solve, language switch mid-solve
    await page.click('[data-nav="drill"]'); await page.selectOption('#street', 'turn');
    await page.click('#start'); await page.click('#cancel'); await page.click('#start');
    await page.selectOption('#lang', 'it'); await page.waitForSelector('#acts button[data-a]', { timeout: 120000 });
    assert.strictEqual(await page.locator('#start').count(), 0);
    await page.selectOption('#lang', 'en');
    await page.click('#acts button[data-a]'); await page.waitForSelector('#result');
    const v = await page.getAttribute('#result', 'data-verdict'); assert(['correct', 'close', 'mistake'].includes(v), v);
    const ev = +(await page.getAttribute('#result', 'data-evloss')), chosen = +(await page.getAttribute('#result', 'data-chosen'));
    const fr = await page.locator(`#freqs .fq[data-a="${chosen}"] .v`).textContent();
    assert.strictEqual(v === 'correct', parseFloat(fr) >= 10 - 0.5, `${v} ${fr}`);
    if (v === 'close') assert(ev < 0.5);
    await page.click('#next'); await page.click('[data-nav="solver"]'); await page.click('[data-nav="drill"]');
    await page.waitForSelector('#start', { timeout: 5000 }); // leaving mid-solve cancelled it: idle screen, not a stuck spinner
    ok('drill-cancel-nav-lang');

    // 13. expired session on result post: clear message, state kept, no loop
    await page.selectOption('#street', 'river');
    await page.click('#start'); await page.waitForSelector('#acts button[data-a]', { timeout: 60000 });
    let posts = 0;
    await page.route('**/api/drills/results', (r) => { posts++; r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }); });
    await page.click('#acts button[data-a]');
    await page.waitForFunction(() => document.getElementById('auth-err'));
    assert.strictEqual(await page.getAttribute('#auth-err', 'data-code'), 'session');
    assert(/expired/i.test(await page.textContent('#auth-err')));
    await page.waitForTimeout(500); assert.strictEqual(posts, 1);
    await page.unroute('**/api/drills/results');
    ok('session-expiry-on-post');

    // 14. result post offline: message shown, drill continues
    await page.goto(base + '/'); await page.waitForSelector('#whoami'); await page.click('[data-nav="drill"]');
    await page.click('#start'); await page.waitForSelector('#acts button[data-a]', { timeout: 60000 });
    await ctx.setOffline(true); await page.click('#acts button[data-a]'); await page.waitForSelector('#result');
    await page.waitForFunction(() => document.getElementById('save-err').textContent.length > 0);
    await ctx.setOffline(false); assert(!(await page.locator('#next').isDisabled()));
    ok('post-offline');

    // 15. two tabs, same account: logout in tab A, tab B gets a clear session message on its next answer
    const b = await ctx.newPage(); b.page = b; await b.goto(base + '/'); await b.waitForSelector('#whoami');
    await b.click('[data-nav="drill"]'); await b.click('#start'); await b.waitForSelector('#acts button[data-a]', { timeout: 60000 });
    await page.click('#logout'); await page.waitForSelector('#auth-err, #do-login');
    await b.click('#acts button[data-a]'); await b.waitForSelector('#auth-err');
    assert.strictEqual(await b.getAttribute('#auth-err', 'data-code'), 'session');
    ok('two-tabs');

    // 16. account: change password (wrong / right), delete account
    await register(page, base);
    await page.click('[data-nav="progress"]'); await page.click('#acct summary');
    await page.fill('#acct-cur', 'wrong-password-1'); await page.fill('#acct-new', 'brand-new-pass-1'); await page.click('#acct-change');
    await page.waitForFunction(() => document.getElementById('acct-err').textContent.length > 0);
    await page.fill('#acct-cur', 'correct-horse-9'); await page.click('#acct-change');
    await page.waitForFunction(() => document.getElementById('acct-msg').textContent.length > 0);
    page.once('dialog', (d) => d.dismiss()); await page.fill('#acct-cur', 'brand-new-pass-1'); await page.click('#acct-delete');
    assert.strictEqual(await page.locator('#whoami').count(), 1);
    page.once('dialog', (d) => d.accept()); await page.click('#acct-delete');
    await page.waitForSelector('#do-login'); assert.strictEqual(await page.locator('#whoami').count(), 0);
    ok('account');
  } finally { await browser.close(); srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
