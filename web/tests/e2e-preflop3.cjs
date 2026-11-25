// E2E for the preflop 3-max trainer against the REAL server (temp DB). Uses the e2e build (dist-e2e, run `npm run build:e2e`), which serves
// the SYNTHETIC fixture at 20/18/16 bb, plus the production build (dist) to prove it has no packs and rejects the fixture.
// Run `npm run build && npm run build:e2e` first. Prints one "OK <name>" line per check and "E2E PREFLOP3 OK" at the end.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const { startServer } = require('./server.cjs');
const PORT = process.env.E2E_P3_PORT || '4610', PORT_PROD = process.env.E2E_P3_PROD_PORT || '4611';
const web = path.join(__dirname, '..');
const out = path.join(web, 'test-artifacts'); fs.mkdirSync(out, { recursive: true });
const ok = (n) => console.log('OK ' + n);
const T = Object.fromEntries(['en', 'es', 'it'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(web, `src/i18n/${l}.json`), 'utf8'))]));
const KEY = { FOLD: 'f', CALL: 'c', RAISE: 'r', '3BET': '3', ALLIN: 'a' };
const FIXTURE = JSON.parse(fs.readFileSync(path.join(web, 'src/preflop3/fixtures/SYNTHETIC-TEST-ONLY.test-fixture.pack.json'), 'utf8'));
const num = (page, sel) => page.$eval(sel, (e) => +e.dataset.v);
// The screen re-renders when async saves/fetches finish, so a click can land on a replaced node: retry until the scope switched.
const toAll = async (page) => { for (let k = 0; k < 10; k++) { await page.click('#p3-score button[data-scope=all]'); if ((await page.getAttribute('#p3-score', 'data-scope')) === 'all') return; await page.waitForTimeout(200); } throw new Error('all-time scope never activated'); };
const score = async (page) => ({ c: await num(page, '#p3-correct'), i: await num(page, '#p3-incorrect'), t: await num(page, '#p3-total'), a: await num(page, '#p3-acc') });

(async () => {
  const e2e = await startServer(PORT, 'gto-e2e-p3-', path.join(web, 'dist-e2e'));
  let prod;
  const browser = await chromium.launch();
  try {
    prod = await startServer(PORT_PROD, 'gto-e2e-p3p-', path.join(web, 'dist'));
    const base = e2e.base;
    const packs = {};
    for (const s of [20, 18, 16]) packs[s] = await (await fetch(`${base}/packs/preflop3/${s}.json`)).json();
    const expected = async (page) => { // verdict computed independently from the pack JSON
      const m = await page.$eval('.p3-table', (e) => ({ stack: +e.dataset.stack, node: e.dataset.node }));
      const cls = await page.$eval('#p3-cards', (e) => e.dataset.class);
      const p = packs[m.stack], n = p.nodes.find((x) => x.id === m.node), row = n.freq[p.classes.indexOf(cls)];
      assert(row, 'dealt a reach-0 class ' + cls);
      return { ...m, cls, n, row, ids: n.actions.map((a) => a.id) };
    };
    const verdictFor = (n, row, j) => {
      if (row[j] >= 0.1 - 1e-9) return 'correct';
      const ev = n.ev && n.ev[0] ? null : null; void ev;
      return 'incorrect';
    };
    const expectVerdict = (x, id, stackPack) => { // mirrors trainer scoring with EV when present
      const j = x.ids.indexOf(id), f = x.row[j];
      if (f >= 0.1 - 1e-9) return 'correct';
      const ev = x.n.ev && x.n.ev[stackPack.classes.indexOf(x.cls)];
      return ev && Math.max(...ev) - ev[j] <= 0.05 + 1e-9 ? 'close' : 'incorrect';
    };
    void verdictFor;
    const open = async (browserCtx, lang, hash = '#/preflop3', q = '') => {
      const page = await browserCtx.newPage();
      page.on('pageerror', (e) => { console.error('PAGEERROR', e.stack); throw e; });
      await page.goto(`${base}/?lang=${lang}&seed=${q || 11}${hash}`);
      return page;
    };
    const stopped = async () => {
      // stale-process guard output (the helper already fails when a port is held)
    };
    void stopped;

    // ---------- 1. empty state on the production build (no packs shipped)
    for (const lang of ['en', 'es', 'it']) {
      const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { throw e; });
      await page.goto(`${prod.base}/?lang=${lang}#/preflop3`);
      await page.waitForSelector('#p3-empty');
      assert.strictEqual(await page.textContent('#p3-empty h3'), T[lang]['preflop3.empty.title']);
      assert.strictEqual(await page.locator('#p3-acts').count(), 0);
      assert.strictEqual(await page.locator('#p3-badge').count(), 0, 'no demo content');
      assert.strictEqual(await page.locator('[data-mode]:not([disabled])').count(), 0, 'all modes disabled');
      assert.strictEqual(await page.getAttribute('#p3-missing', 'data-missing'), '20,18,16');
      assert((await page.textContent('#p3-empty')).includes('docs/preflop3-design.md'));
      assert(await page.isVisible('#p3-import'));
      assert(await page.isVisible('#p3-score'));
      if (lang !== 'en') assert.notStrictEqual(await page.textContent('#p3-empty h3'), T.en['preflop3.empty.title']);
      assert.strictEqual(await page.textContent('.side [aria-current=page] span'), T[lang]['nav.preflop3']);
      ok(`empty-state prod ${lang}`);
      await ctx.close();
    }

    // ---------- 2. production build rejects the fixture (served via route, and imported as a file)
    {
      const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      const page = await ctx.newPage();
      await page.route('**/packs/preflop3/*', (r) => {
        const u = new URL(r.request().url()).pathname;
        if (u.endsWith('index.json')) return r.fulfill({ json: { packs: ['20.json'] } });
        return r.fulfill({ json: FIXTURE });
      });
      await page.goto(`${prod.base}/?lang=en#/preflop3`);
      await page.waitForSelector('.p3-static-err');
      assert.strictEqual(await page.locator('.p3-static-err li[data-code=E_FIXTURE_IN_PROD]').count(), 1);
      assert.strictEqual(await page.locator('#p3-acts').count(), 0);
      assert.strictEqual(await page.locator('#p3-badge').count(), 0);
      await page.setInputFiles('#p3-file', { name: 'fx.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(FIXTURE)) });
      await page.waitForSelector('#p3-import-errors li[data-code=E_FIXTURE_IN_PROD]');
      assert.strictEqual(await page.locator('#p3-acts').count(), 0);
      ok('prod build rejects test-fixture (static + import)');
      await ctx.close();
    }

    // ---------- 3. e2e build accepts it; import errors are localized validator codes; import persists in IndexedDB
    for (const lang of ['en', 'es', 'it']) {
      const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { throw e; });
      await page.route('**/packs/preflop3/index.json', (r) => r.fulfill({ status: 404, body: '{}' })); // no static packs
      await page.goto(`${base}/?lang=${lang}&seed=5#/preflop3`);
      await page.waitForSelector('#p3-empty');
      // broken pack: bad frequency row + not-JSON file
      const bad = structuredClone(FIXTURE); bad.nodes[1].freq[0] = [0.5, 0.5, 0.5];
      await page.setInputFiles('#p3-file', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
      await page.waitForSelector('#p3-import-errors li[data-code=E_SUM]');
      const li = await page.textContent('#p3-import-errors li[data-code=E_SUM]');
      assert(li.includes('nodes[n1].freq[AA]') || li.includes('n1'), 'path shown: ' + li);
      assert(li.includes(T[lang]['preflop3.err.E_SUM']), 'localized message: ' + li);
      assert.strictEqual(await page.locator('#p3-acts').count(), 0);
      await page.setInputFiles('#p3-file', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('not json{') });
      await page.waitForSelector('#p3-import-errors li[data-code=E_JSON]');
      const odd = structuredClone(FIXTURE); odd.meta.stacksBb = { BTN: 25, SB: 25, BB: 25 };
      await page.setInputFiles('#p3-file', { name: 'odd.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(odd)) });
      await page.waitForFunction(() => document.querySelectorAll('#p3-import-errors li').length > 0 && !document.querySelector('#p3-import-errors li[data-code=E_JSON]'));
      // valid pack (20 bb) imports, then only 20 BB and mix are enabled
      await page.setInputFiles('#p3-file', { name: 'ok.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(FIXTURE)) });
      await page.waitForSelector('#p3-import-ok');
      await page.waitForSelector('#p3-acts');
      assert.strictEqual(await page.locator('[data-mode]:not([disabled])').count(), 2);
      assert.strictEqual(await page.getAttribute('#p3-missing', 'data-missing'), '18,16');
      assert.strictEqual(await page.getAttribute('#p3-badge', 'data-kind'), 'test');
      await page.reload(); // IndexedDB keeps the imported pack on this device; index is still 404
      await page.waitForSelector('#p3-acts');
      assert.strictEqual(await page.getAttribute('.p3-table', 'data-stack'), '20');
      ok(`import errors + persistence ${lang}`);
      await ctx.close();
    }

    // ---------- 4. badge text per verification status (route-served variants on the e2e build)
    {
      const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      const variants = {
        'external-verified': (p) => { p.meta.verification = 'external-verified'; p.meta.source = { kind: 'external', solver: 'TestSolverX', version: '1' }; },
        'self-computed-unverified': (p) => { p.meta.verification = 'self-computed-unverified'; p.meta.source = { kind: 'self', solver: 'gto-engine', version: '0' }; },
        'test-fixture': () => {},
      };
      for (const lang of ['en', 'es', 'it']) for (const [v, mod] of Object.entries(variants)) {
        const page = await ctx.newPage();
        page.on('pageerror', (e) => { throw e; });
        const p = structuredClone(packs[20]); mod(p);
        await page.route('**/packs/preflop3/*', (r) => r.request().url().endsWith('index.json') ? r.fulfill({ json: { packs: ['20.json'] } }) : r.fulfill({ json: p }));
        await page.goto(`${base}/?lang=${lang}&seed=3#/preflop3`);
        await page.waitForSelector('#p3-badge');
        const kind = { 'external-verified': 'verified', 'self-computed-unverified': 'unverified', 'test-fixture': 'test' }[v];
        assert.strictEqual(await page.getAttribute('#p3-badge', 'data-kind'), kind);
        const want = kind === 'verified' ? T[lang]['preflop3.badge.verified'].replace('{solver}', 'TestSolverX') : T[lang][`preflop3.badge.${kind === 'test' ? 'test' : 'unverified'}`];
        assert.strictEqual((await page.textContent('#p3-badge')).trim(), want);
        const color = await page.$eval('#p3-badge', (e) => getComputedStyle(e).backgroundColor);
        assert(await page.isVisible('#p3-badge'));
        await page.click('#p3-details summary');
        const det = await page.textContent('#p3-details dl');
        assert(det.includes(p.meta.packId) && det.includes(p.meta.source.solver), 'details show pack id and source');
        if (kind === 'unverified') assert(want.startsWith(lang === 'en' ? 'UNVERIFIED' : lang === 'es' ? 'SIN VERIFICAR' : 'NON VERIFICATO'));
        void color;
        // mode availability with a single pack
        assert.strictEqual(await page.locator('[data-mode]:not([disabled])').count(), 2);
        await page.close();
      }
      ok('badge text per verification status x en/es/it');
      await ctx.close();
    }

    // ---------- 5. trainer flow per language: modes, scoring, scoreboard, keyboard, reload
    for (const lang of ['en', 'es', 'it']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await open(ctx, lang);
      await page.waitForSelector('#p3-acts');
      assert.strictEqual(await page.title(), `${T[lang]['app.name']} - ${T[lang]['nav.preflop3']}`);
      assert.strictEqual((await page.textContent('#p3-badge')).trim(), T[lang]['preflop3.badge.test']);
      // before answering: table facts yes, solution no
      assert.strictEqual(await page.locator('.p3-seat').count(), 3);
      assert.strictEqual(await page.locator('.p3-seat[data-hero="1"]').count(), 1);
      assert.strictEqual(await page.locator('.p3-seat[data-pos=BTN] .p3-dealer').count(), 1);
      assert((await page.textContent('#p3-pot')).trim().length > 0);
      assert.strictEqual(await page.locator('#p3-cards .card').count(), 2);
      assert.strictEqual(await page.locator('#p3-bars, #p3-grid, #p3-verdict, #p3-expl').count(), 0, 'solution hidden before the answer');
      const st = { c: 0, i: 0, t: 0 };
      const seen = { verdicts: new Set(), stacks: new Set(), keys: new Set(), mixedBoth: false };
      const answer = async (how) => {
        const x = await expected(page);
        seen.stacks.add(x.stack);
        const ids = await page.$$eval('.p3-act', (b) => b.map((e) => e.dataset.action));
        assert.deepStrictEqual(ids.slice().sort(), x.ids.slice().sort(), 'only the actions of this node are offered');
        const j = how === 'min' ? x.row.indexOf(Math.min(...x.row)) : how === 'max' ? x.row.indexOf(Math.max(...x.row)) : x.ids.indexOf(how);
        const id = x.ids[j];
        if (how === 'key') throw new Error('unused');
        await page.click(`.p3-act[data-action="${id}"]`);
        await page.waitForSelector('#p3-verdict');
        const v = expectVerdict(x, id, packs[x.stack]);
        assert.strictEqual(await page.getAttribute('#p3-verdict', 'data-verdict'), v, `verdict for ${x.cls} ${id} at ${x.node}/${x.stack}`);
        assert.strictEqual(await page.textContent('#p3-verdict b'), T[lang][`preflop3.verdict.${v}`]);
        assert(Math.abs(+(await page.getAttribute('#p3-verdict', 'data-freq')) - x.row[j]) < 1e-9);
        for (let k = 0; k < x.ids.length; k++) assert(Math.abs(+(await page.getAttribute(`#p3-bars .fq[data-action="${x.ids[k]}"]`, 'data-freq')) - x.row[k]) < 1e-9, 'bars show every action');
        assert.strictEqual(await page.locator('#p3-grid .c').count(), 169);
        assert.strictEqual(await page.getAttribute('#p3-grid .c.me', 'data-hand'), x.cls);
        assert((await page.locator('#p3-expl li').count()) >= 4);
        assert(await page.isVisible('#p3-next'));
        if (x.row.filter((f) => f >= 0.1).length > 1 && x.row[j] >= 0.1) seen.mixedBoth = true;
        seen.verdicts.add(v);
        st.t++; if (v === 'correct') st.c++; else st.i++;
        const s = await score(page);
        assert.deepStrictEqual([s.c, s.i, s.t], [st.c, st.i, st.t], 'scoreboard counters');
        assert.strictEqual(s.a, Math.round((st.c / st.t) * 1000) / 10);
        return { x, id, v };
      };
      // 5a. each stack mode serves its own pack
      for (const s of ['20', '18', '16']) {
        await page.click(`[data-mode="${s}"]`);
        await page.waitForSelector('#p3-acts');
        assert.strictEqual(await page.getAttribute('.p3-table', 'data-stack'), s);
        assert.strictEqual(await page.getAttribute(`[data-mode="${s}"]`, 'aria-pressed'), 'true');
        await answer(s === '20' ? 'max' : 'min');
        await page.keyboard.press('Enter'); await page.waitForSelector('#p3-acts');
      }
      ok(`stack modes 20/18/16 ${lang}`);
      // 5b. mix uses all loaded stacks
      await page.click('[data-mode="mix"]'); await page.waitForSelector('#p3-acts');
      for (let k = 0; k < 14; k++) { await answer(k % 2 ? 'min' : 'max'); await page.click('#p3-next'); await page.waitForSelector('#p3-acts'); }
      assert(seen.stacks.size === 3, 'mix reached all stacks: ' + [...seen.stacks]);
      ok(`random mix ${lang}`);
      // 5c. mixed-frequency scoring: every action with freq >= 10% counts as correct, a 0% one as incorrect
      await page.click('[data-mode="20"]'); await page.waitForSelector('#p3-acts');
      let both = 0, zero = 0;
      for (let k = 0; k < 60 && (both < 2 || zero < 1); k++) {
        const x = await expected(page);
        const live = x.ids.filter((_, j) => x.row[j] >= 0.1), dead = x.ids.filter((_, j) => x.row[j] < 0.1);
        let pick = 'max';
        if (live.length > 1 && both < 2) { both++; pick = live[both % live.length]; }
        else if (dead.length && zero < 1) { zero++; pick = dead[0]; }
        const r = await answer(pick);
        assert.strictEqual(r.v, live.includes(r.id) ? 'correct' : 'incorrect');
        await page.keyboard.press('Enter'); await page.waitForSelector('#p3-acts');
      }
      assert(both >= 2 && zero >= 1, `mixed-frequency spots found (both=${both} zero=${zero})`);
      assert(seen.verdicts.has('correct') && seen.verdicts.has('incorrect'));
      ok(`mixed-frequency scoring ${lang}`);
      // 5d. keyboard shortcuts F C R 3 A, Enter = next
      await page.click('[data-mode="mix"]'); await page.waitForSelector('#p3-acts');
      for (let k = 0; k < 120 && seen.keys.size < 5; k++) {
        const btns = await page.$$eval('.p3-act', (b) => b.map((e) => [e.dataset.btn, e.dataset.action]));
        const want = btns.find(([b]) => !seen.keys.has(b)) || btns[0];
        const first = btns.find(([b]) => b === want[0]); // shortcut picks the first action of that button
        const pressed = KEY[want[0]];
        await page.keyboard.press(k % 2 ? pressed.toUpperCase() : pressed);
        await page.waitForSelector('#p3-verdict');
        assert.strictEqual(await page.getAttribute('#p3-verdict', 'data-action'), first[1], 'shortcut ' + pressed);
        seen.keys.add(want[0]); st.t++;
        const x = await page.$eval('#p3-verdict', (e) => e.dataset.verdict); x === 'correct' ? st.c++ : st.i++;
        await page.keyboard.press('Enter'); await page.waitForSelector('#p3-acts');
        assert.strictEqual(await page.locator('#p3-verdict').count(), 0, 'Enter moved on');
      }
      assert.strictEqual(seen.keys.size, 5, 'all of FOLD/CALL/RAISE/3BET/ALLIN covered: ' + [...seen.keys]);
      const s1 = await score(page); assert.deepStrictEqual([s1.c, s1.i, s1.t], [st.c, st.i, st.t]);
      ok(`keyboard shortcuts F C R 3 A + Enter ${lang}`);
      // 5e. session counters survive a reload; reset needs confirmation
      await page.reload(); await page.waitForSelector('#p3-acts');
      const s2 = await score(page); assert.deepStrictEqual([s2.c, s2.i, s2.t], [st.c, st.i, st.t], 'session persists after reload');
      await page.click('#p3-reset'); await page.waitForSelector('#p3-confirm');
      await page.click('#p3-confirm-no'); assert.strictEqual((await score(page)).t, st.t);
      await page.click('#p3-reset'); await page.click('#p3-confirm-yes');
      assert.deepStrictEqual(await score(page), { c: 0, i: 0, t: 0, a: 0 });
      ok(`scoreboard persist + reset ${lang}`);
      await ctx.close();
    }

    // ---------- 6. close tier (16 bb pack) counts as incorrect and shows the note
    {
      const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      const page = await open(ctx, 'en', '#/preflop3', '21');
      await page.click('[data-mode="16"]');
      let found = false;
      for (let k = 0; k < 80 && !found; k++) {
        await page.waitForSelector('#p3-acts');
        const node = await page.getAttribute('.p3-table', 'data-node');
        if (node === 'n1') {
          await page.click('.p3-act[data-action="F"]'); await page.waitForSelector('#p3-verdict');
          assert.strictEqual(await page.getAttribute('#p3-verdict', 'data-verdict'), 'close');
          assert((await page.textContent('#p3-verdict')).includes('EV'));
          assert.strictEqual(await num(page, '#p3-incorrect'), 1); assert.strictEqual(await num(page, '#p3-correct'), 0);
          found = true;
        } else { await page.click('.p3-act'); await page.waitForSelector('#p3-verdict'); await page.keyboard.press('Enter'); }
      }
      assert(found, 'reached n1 at 16 bb');
      ok('close tier = Close banner, counted incorrect');
      await ctx.close();
    }

    // ---------- 7. server persistence: results saved, all-time from the server, isolation, drills untouched
    {
      const mk = () => browser.newContext({ viewport: { width: 1100, height: 900 } });
      const user = 'p3u' + (Date.now() % 100000);
      const ctx = await mk();
      let page = await open(ctx, 'en', '#/preflop3');
      await page.waitForSelector('#p3-acts');
      await page.click('#to-auth'); await page.fill('#u', user); await page.fill('#pw', 'correct-horse-9'); await page.click('#do-register');
      await page.waitForSelector('#whoami');
      await page.click('[data-nav="preflop3"]'); await page.waitForSelector('#p3-acts');
      assert.strictEqual(await page.getAttribute('#p3-score button[data-scope=all]', 'title'), null);
      let c = 0, w = 0;
      for (let k = 0; k < 8; k++) {
        const x = await expected(page);
        const id = x.ids[x.row.indexOf(k % 2 ? Math.min(...x.row) : Math.max(...x.row))];
        await page.click(`.p3-act[data-action="${id}"]`); await page.waitForSelector('#p3-verdict');
        (expectVerdict(x, id, packs[x.stack]) === 'correct') ? c++ : w++;
        await page.keyboard.press('Enter'); await page.waitForSelector('#p3-acts');
      }
      await page.waitForFunction(async () => (await (await fetch('/api/progress?source=preflop3')).json()).total === 8, null, { timeout: 15000 });
      const prog = await page.evaluate(async () => (await fetch('/api/progress?source=preflop3')).json());
      assert.strictEqual(prog.total, 8);
      assert.strictEqual(prog.correct, c); assert.strictEqual(prog.close + prog.incorrect, w);
      assert.strictEqual((await page.evaluate(async () => (await fetch('/api/progress')).json())).total, 0, 'drill totals untouched');
      await toAll(page);
      assert.strictEqual(await page.getAttribute('#p3-score', 'data-scope'), 'all');
      assert.deepStrictEqual(await score(page), { c, i: w, t: 8, a: Math.round((c / 8) * 1000) / 10 });
      ok('results POSTed with meta; progress group isolated from drills');
      // new device: session empty, all-time from the server after login
      const ctx2 = await mk();
      page = await open(ctx2, 'en', '#/preflop3');
      await page.waitForSelector('#p3-acts');
      assert.strictEqual((await score(page)).t, 0);
      assert.strictEqual(await page.isDisabled('#p3-score button[data-scope=all]'), true, 'all-time needs a login');
      await page.click('#to-auth'); await page.fill('#u', user); await page.fill('#pw', 'correct-horse-9'); await page.click('#do-login');
      await page.waitForSelector('#whoami');
      await page.click('[data-nav="preflop3"]');
      await page.waitForFunction(() => !document.querySelector('#p3-score button[data-scope=all]').disabled);
      await toAll(page);
      assert.strictEqual((await score(page)).t, 8);
      await page.reload(); await page.waitForSelector('#p3-acts');
      await page.waitForFunction(() => !document.querySelector('#p3-score button[data-scope=all]').disabled);
      await toAll(page);
      assert.strictEqual((await score(page)).t, 8, 'all-time persists after reload');
      // another user sees nothing
      const ctx3 = await mk();
      page = await open(ctx3, 'en', '#/preflop3');
      await page.click('#to-auth'); await page.fill('#u', user + 'b'); await page.fill('#pw', 'correct-horse-9'); await page.click('#do-register');
      await page.waitForSelector('#whoami');
      assert.strictEqual((await page.evaluate(async () => (await fetch('/api/progress?source=preflop3')).json())).total, 0);
      ok('all-time via server, persists after reload, per-user isolation');
      await ctx.close(); await ctx2.close(); await ctx3.close();
    }

    // ---------- 8. phone layout + screenshots
    for (const [w, h, tag] of [[360, 740, 'phone360'], [390, 844, 'phone390'], [1440, 900, 'desktop1440']]) {
      for (const lang of tag === 'phone360' ? ['en', 'it'] : ['en']) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 800, isMobile: w < 800, deviceScaleFactor: 1 });
        const page = await open(ctx, lang, '#/preflop3', '9');
        await page.waitForSelector('#p3-acts');
        const geo = async (name) => {
          const m = await page.evaluate(() => {
            const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, h: b.height }; };
            return { sw: document.documentElement.scrollWidth, iw: innerWidth, ih: innerHeight, score: r('#p3-score'), nav: r('.side'), pos: getComputedStyle(document.getElementById('p3-score')).position };
          });
          assert(m.sw <= m.iw, `${tag} ${name} horizontal overflow ${m.sw}>${m.iw}`);
          assert.strictEqual(m.pos, 'fixed');
          assert(m.score.b <= m.ih + 0.5 && m.score.t >= 0, `${tag} score bar in viewport`);
          if (w < 700) assert(m.score.b <= m.nav.t + 1, `${tag} score bar sits above the nav`);
          await page.screenshot({ path: `${out}/p3-${tag}-${lang}-${name}.png`, fullPage: true });
        };
        await geo('ask');
        const sizes = await page.$$eval('.p3-act', (b) => b.map((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }));
        assert(sizes.every(([bw, bh]) => bw >= 100 && bh >= 56), `${tag} big buttons: ${JSON.stringify(sizes)}`);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const vis = await page.$eval('.p3-act:last-child', (e) => { const r = e.getBoundingClientRect(), s = document.getElementById('p3-score').getBoundingClientRect(); return r.bottom <= s.top + 1; });
        assert(vis, `${tag} buttons can scroll clear of the score bar`);
        await page.click('.p3-act'); await page.waitForSelector('#p3-verdict');
        await geo('result');
        ok(`layout ${tag} ${lang}`);
        await ctx.close();
      }
    }
    console.log('E2E PREFLOP3 OK');
  } finally { await browser.close(); e2e.srv.kill(); if (prod) prod.srv.kill(); }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
