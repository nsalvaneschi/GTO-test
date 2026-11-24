const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const assert = require('assert');
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: __dirname + '/..', detached: true });
  let srvErr = '';
  srv.stderr.on('data', (d) => { srvErr += String(d); });
  // Fail loudly (never exit 0 silently) if the preview server cannot start, e.g. a stale one holds the port.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview server did not start in 30s: ' + srvErr)), 30000);
    srv.on('exit', (code) => { clearTimeout(timer); reject(new Error('preview server exited (' + code + '): ' + srvErr)); });
    srv.stdout.on('data', (d) => { if (/4173/.test(String(d))) { clearTimeout(timer); resolve(); } });
  });
  srv.removeAllListeners('exit');
  const out = __dirname + '/../test-artifacts'; fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const labels = {}; const actions = {};
  try {
    for (const lang of ['en', 'es', 'it']) {
      const page = await browser.newPage({ viewport: { width: 700, height: 760 }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => { throw e; });
      await page.goto(`http://localhost:4173/?lang=${lang}`);
      await page.fill('#pot', '10');
      const t0 = Date.now();
      await page.click('#solve');
      await page.waitForFunction(() => !document.getElementById('solve').disabled, null, { timeout: 120000 });
      const expl = +(await page.getAttribute('#expl', 'data-value'));
      assert(expl < 1, `${lang} expl ${expl}`);
      await page.waitForSelector('#grid .c[data-hand="AKs"]');
      assert.strictEqual(await page.locator('#grid .c').count(), 169);
      const colored = await page.locator('#grid .c[style*="linear-gradient"]').count();
      assert(colored >= 15, 'colored cells ' + colored);
      // navigate: first action button (check) then back
      const before = await page.textContent('#info');
      await page.click('button[data-i="1"]'); // bet
      await page.waitForFunction((b) => document.getElementById('info').textContent !== b, before);
      await page.click('#back');
      await page.waitForSelector('button[data-i="1"]');
      const acts = (await page.textContent('#acts')) + '|' + (await page.textContent('#legend'));
      if (lang !== 'en') assert(!/Fold|Call|Raise|Check|Bet\b/.test(acts), lang + ' english action word: ' + acts);
      actions[lang] = acts;
      const T = JSON.parse(fs.readFileSync(__dirname + `/../src/i18n/${lang}.json`, 'utf8'));
      const want = `${T['app.name']} - ${T['nav.solver']}`;
      assert.strictEqual(await page.textContent('h1#title'), want);
      assert.strictEqual(await page.title(), want);
      assert.strictEqual(await page.getAttribute('html', 'lang'), lang);
      labels[lang] = want + '|' + (await page.textContent('#solve'));
      console.log(lang, 'expl%pot', expl, 'ms', Date.now() - t0, 'colored', colored, 'after-bet:', await page.textContent('#info'));
      await page.screenshot({ path: `${out}/${lang}.png` });
      await page.close();
    }
    assert.strictEqual(new Set(Object.values(labels)).size, 3, JSON.stringify(labels));
    assert.strictEqual(new Set(Object.values(actions)).size, 3, JSON.stringify(actions));
    console.log('OK', labels);
  } finally { await browser.close(); try { process.kill(-srv.pid); } catch (e) { try { srv.kill(); } catch (e2) {} } }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
