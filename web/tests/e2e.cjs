// End-to-end against a REAL server (node server/src/index.js) serving web/dist. Run `npm run build` first.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const { startServer } = require('./server.cjs');
const PORT = process.env.E2E_PORT || '4599', base = `http://localhost:${PORT}`;
(async () => {
  const { srv, base: _b, log: _log } = await startServer(PORT, 'gto-e2e-');
  const out = path.join(__dirname, '..', 'test-artifacts'); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const EN = /\b(Fold|Check|Call|Bet|Raise|Next hand|Progress|Accuracy|Streak|Mistake|Correct|Your hand|Log out|Log in|Register|EV loss|Start drill|Mean|answers?|days?|Username|Choose|Signed in)\b/;
  const seen = { drill: {}, progress: {}, err: {} };
  try {
    for (const lang of ['en', 'es', 'it']) {
      const ctx = await browser.newContext({ viewport: { width: 700, height: 900 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { throw e; });
      const posts = [];
      page.on('request', (r) => { if (r.url().endsWith('/api/drills/results') && r.method() === 'POST') posts.push(JSON.parse(r.postData())); });
      await page.goto(`${base}/?lang=${lang}`);
      // drill requires login
      await page.click('[data-nav="drill"]');
      await page.waitForSelector('#need-login');
      // errors: validation + generic bad login
      const user = `u_${lang}_${Date.now() % 100000}`, pw = 'correct-horse-9';
      await page.click('#to-auth');
      await page.fill('#u', 'a!'); await page.fill('#pw', pw); await page.click('#do-register');
      await page.waitForFunction(() => document.getElementById('auth-err').dataset.code === 'invalid_username');
      const eUser = await page.textContent('#auth-err');
      await page.fill('#u', user); await page.fill('#pw', 'short'); await page.click('#do-register');
      await page.waitForFunction(() => document.getElementById('auth-err').dataset.code === 'invalid_password');
      await page.fill('#pw', 'wrong-password-1'); await page.click('#do-login');
      await page.waitForFunction(() => document.getElementById('auth-err').dataset.code === 'invalid_credentials');
      const eBad = await page.textContent('#auth-err');
      seen.err[lang] = eUser + '|' + eBad;
      // register
      await page.fill('#pw', pw); await page.click('#do-register');
      await page.waitForSelector('#whoami');
      assert.strictEqual(await page.getAttribute('#whoami', 'data-user'), user);
      // progress empty state
      await page.click('[data-nav="progress"]'); await page.waitForSelector('#p-empty');
      await page.click('[data-nav="drill"]');
      // 3 drill answers
      const t0 = Date.now();
      let n = 0, nonRoot = 0;
      for (; n < 3 || (!nonRoot && n < 15); n++) {
        await page.click(n === 0 ? '#start' : '#next');
        await page.waitForSelector('#acts button[data-a]', { timeout: 180000 });
        if (n === 0) console.log(lang, 'solve+deal ms', Date.now() - t0);
        const combo = await page.getAttribute('#hand', 'data-combo');
        assert.strictEqual(await page.locator('#board-cards .card').count(), 5);
        assert.strictEqual(await page.locator('#hand .card').count(), 2);
        const nAct = await page.locator('#acts button[data-a]').count();
        const node = await page.getAttribute('#history', 'data-node');
        assert(/^(root|after-check|facing-bet|facing-raise)$/.test(node), node);
        assert.strictEqual(await page.locator('#history').getAttribute('data-depth') === '0', node === 'root');
        const histTxt = await page.innerText('#history');
        if (lang !== 'en') assert(!EN.test(histTxt), `${lang} english word in history: ${histTxt}`);
        if (node !== 'root' && !nonRoot) { await page.screenshot({ path: `${out}/drill-nonroot-${lang}.png` }); console.log(lang, 'non-root node', node, histTxt); }
        if (node !== 'root') nonRoot++;
        await page.click(`#acts button[data-a="${n % nAct}"]`);
        await page.waitForSelector('#result');
        assert.strictEqual(await page.getAttribute('#session', 'data-total'), String(n + 1));
        const body = await page.innerText('#screen');
        if (lang !== 'en') assert(!EN.test(body), `${lang} english word in drill: ${body.match(EN)}`);
        await page.waitForFunction((c) => !document.getElementById('save-err').textContent, null);
        assert.strictEqual(await page.locator('#grid .c').count(), 169);
        assert.strictEqual(await page.locator('#grid .c.me').count(), 1);
        assert.strictEqual(posts[n].handCombo, combo);
      }
      assert.strictEqual(posts.length, n);
      assert(nonRoot > 0, 'no non-root node reached');
      for (const p of posts) assert(/^river:(root|after-check|facing-bet|facing-raise):/.test(p.spotId), p.spotId);
      await page.screenshot({ path: `${out}/drill-${lang}.png` });
      // turn drills: 4-card board, turn spot ids, cancel button during solve
      await page.click('#next'); // river 'next' starts another river drill; cancel it, then switch street
      // Click Cancel inside the page right away: Playwright's click() waits for 2 animation frames of stability, which
      // can outlast a ~0.2 s river solve (the button is replaced when the solve completes) and caused a flaky timeout.
      const cancelled = await page.evaluate(() => { const b = document.getElementById('cancel'); if (b) b.click(); return !!b; });
      assert(cancelled, 'cancel button was not present right after starting a drill');
      await page.waitForSelector('#street');
      assert.strictEqual(posts.length, n);
      await page.selectOption('#street', 'turn');
      for (let k = 0; k < 2; k++) {
        const ts = Date.now();
        await page.click(k === 0 ? '#start' : '#next');
        if (k === 0) { await page.waitForSelector('#cancel'); }
        await page.waitForSelector('#acts button[data-a]', { timeout: 180000 });
        console.log(lang, 'turn solve+deal ms', Date.now() - ts, 'solve ms', await page.getAttribute('#history', 'data-solve-ms'));
        assert.strictEqual(await page.locator('#board-cards .card').count(), 4);
        assert.strictEqual(await page.getAttribute('#history', 'data-street'), 'turn');
        const nAct = await page.locator('#acts button[data-a]').count();
        await page.click(`#acts button[data-a="${k % nAct}"]`);
        await page.waitForSelector('#result');
        if (k === 1) await page.screenshot({ path: `${out}/drill-turn-${lang}.png` });
        await page.waitForFunction(() => !document.getElementById('save-err').textContent);
      }
      assert.strictEqual(posts.length, n + 2);
      for (const p of posts.slice(n)) assert(/^turn:(root|after-check|facing-bet|facing-raise):[A-Za-z0-9]{8}:/.test(p.spotId), p.spotId);
      seen.drill[lang] = (await page.innerText('#screen')).split('\n').slice(0, 14).join('|');
      // progress matches posted values
      const check = async () => {
        await page.click('[data-nav="progress"]'); await page.waitForSelector('#p-total');
        const exp = {
          acc: posts.filter((p) => p.solverFreqs[p.action] >= 0.1).length / posts.length,
          ev: posts.reduce((a, p) => a + p.evLoss, 0) / posts.length,
        };
        assert.strictEqual(await page.getAttribute('#p-total', 'data-value'), String(posts.length));
        assert(Math.abs(+await page.getAttribute('#p-acc', 'data-value') - exp.acc) < 1e-9);
        assert(Math.abs(+await page.getAttribute('#p-ev', 'data-value') - exp.ev) < 1e-6, 'ev');
        assert.strictEqual(await page.getAttribute('#p-streak', 'data-value'), '1');
        assert.strictEqual(await page.locator('#chart rect').count(), 30);
        assert.strictEqual(await page.locator(`#chart rect[data-total="${posts.length}"]`).count(), 1);
        const types = {}; for (const p of posts) { const t = p.spotId.split(':').slice(0, 2).join(':'); types[t] = (types[t] ?? 0) + 1; }
        assert.strictEqual(await page.locator('#by-spot tr').count(), Object.keys(types).length);
        assert(Object.keys(types).some((t) => t !== 'river:root'), 'breakdown has no non-root type');
        assert(Object.keys(types).some((t) => t.startsWith('turn:')), 'progress has no turn row');
        for (const [t, c] of Object.entries(types)) {
          const row = page.locator(`#by-spot tr[data-type="${t}"]`);
          assert.strictEqual(await row.count(), 1, t);
          assert((await row.innerText()).startsWith(t.startsWith('turn') ? 'Turn' : 'River'), 'localized label ' + t);
          assert(!/^(river|turn):/.test(await row.innerText()), 'raw key shown ' + t);
          assert.strictEqual(+(await row.locator('td').nth(1).innerText()).match(/\d+/)[0], c, t);
        }
        return exp;
      };
      const exp = await check();
      const ptxt = await page.innerText('#screen');
      if (lang !== 'en') assert(!EN.test(ptxt), `${lang} english word in progress: ${ptxt.match(EN)}`);
      seen.progress[lang] = ptxt.split('\n').slice(0, 8).join('|');
      await page.screenshot({ path: `${out}/progress-${lang}.png` });
      // logout / login: data persists
      await page.click('#logout'); await page.waitForSelector('#do-login');
      await page.click('[data-nav="progress"]'); await page.waitForSelector('#need-login');
      await page.click('#to-auth2'); await page.fill('#u', user); await page.fill('#pw', pw); await page.click('#do-login');
      await page.waitForSelector('#whoami');
      await check();
      await page.reload(); await page.waitForSelector('#whoami', { timeout: 5000 }).catch(() => {});
      console.log(lang, 'OK posts', posts.map((p) => `${p.handCombo}:${p.action}:ev${p.evLoss.toFixed(2)}%:f${p.solverFreqs.map((x) => x.toFixed(2))}`).join(' '), 'acc', exp.acc, 'meanEv%pot', exp.ev.toFixed(3));
      await ctx.close();
    }
    for (const k of ['drill', 'progress', 'err']) assert.strictEqual(new Set(Object.values(seen[k])).size, 3, k + JSON.stringify(seen[k]));
    console.log('E2E OK');
  } catch (e) { console.error(_log()); throw e; } finally { await browser.close(); srv.kill(); }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
