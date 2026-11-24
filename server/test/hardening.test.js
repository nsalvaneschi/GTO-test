import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

async function boot(opts = {}) {
  const db = openDb(':memory:');
  const clock = { t: Date.UTC(2026, 5, 15, 12) };
  const srv = createApp({ db, now: () => clock.t, ...opts });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, cookie, headers = {}) => {
    const r = await fetch(base + path, { method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
    const sc = r.headers.get('set-cookie');
    return { status: r.status, json, text, headers: r.headers, setCookie: sc, cookie: sc ? sc.split(';')[0] : null };
  };
  // raw request so the path is sent exactly as given (fetch normalises "..")
  const raw = (path, method = 'GET') => new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port, path, method }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, text: d }));
    }); q.on('error', rej); q.end();
  });
  return { db, clock, base, call, raw, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const creds = (u, p = 'password123') => ({ username: u, password: p });
const H = 'a'.repeat(64);
const hand = (id, o = {}) => ({ site: 'pokerstars', hand_id: id, played_at: 1700000000000, stakes: { sb: 0.5, bb: 1 },
  seats: [{ seat: 1, name_hash: H, stack: 100, is_hero: true }, { seat: 2, name_hash: 'b'.repeat(64), stack: 100, is_hero: false }],
  hero_cards: ['As', 'Kd'], board: ['2c', '7d', 'Th', 'Js', '3s'], actions: [], pot_by_street: [3], ...o });
const dec = (handRow, o = {}) => ({ handRow, street: 'river', nodePath: 'x', actionIdx: 0, status: 'approx_only',
  rangePreset: 'p', engineVer: '1', ...o });

test('login limiter: success resets own key, other users unaffected, 429 resets after window', async () => {
  const s = await boot({ rateLimit: { max: 3, windowMs: 60000 } });
  await s.call('POST', '/api/register', creds('dave'));
  await s.call('POST', '/api/register', creds('erin'));
  for (let i = 0; i < 2; i++) await s.call('POST', '/api/login', creds('dave', 'badbadbad'));
  assert.equal((await s.call('POST', '/api/login', creds('dave'))).status, 200); // reset
  for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/api/login', creds('dave', 'badbadbad'))).status, 401);
  const r = await s.call('POST', '/api/login', creds('dave', 'badbadbad'));
  assert.equal(r.status, 429); assert.deepEqual(r.json, { error: 'rate_limited' });
  assert.equal((await s.call('POST', '/api/login', creds('DAVE'))).status, 429); // case-insensitive key
  assert.equal((await s.call('POST', '/api/login', creds('erin'))).status, 200); // unaffected
  s.clock.t += 60001;
  assert.equal((await s.call('POST', '/api/login', creds('dave'))).status, 200);
  s.close();
});

test('register limiter: per IP across usernames, resets after window', async () => {
  const s = await boot({ rateLimit: { max: 2, windowMs: 60000 } });
  assert.equal((await s.call('POST', '/api/register', creds('user1'))).status, 201);
  assert.equal((await s.call('POST', '/api/register', creds('user2'))).status, 201);
  assert.equal((await s.call('POST', '/api/register', creds('user3'))).status, 429);
  s.clock.t += 60001;
  assert.equal((await s.call('POST', '/api/register', creds('user3'))).status, 201);
  s.close();
});

test('x-forwarded-* only trusted with trustProxy (cookie Secure + limiter IP)', async () => {
  const off = await boot();
  const r = await off.call('POST', '/api/register', creds('harry'), undefined, { 'x-forwarded-proto': 'https' });
  assert.ok(!r.setCookie.includes('Secure'));
  off.close();
  const on = await boot({ trustProxy: true, rateLimit: { max: 1, windowMs: 60000 } });
  const a = await on.call('POST', '/api/register', creds('ann'), undefined, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.1.1.1' });
  assert.ok(a.setCookie.includes('; Secure'));
  assert.equal((await on.call('POST', '/api/register', creds('bob'), undefined, { 'x-forwarded-for': '2.2.2.2' })).status, 201);
  assert.equal((await on.call('POST', '/api/register', creds('cat'), undefined, { 'x-forwarded-for': '9.9.9.9, 2.2.2.2' })).status, 429);
  on.close();
});

test('hand cap: exact default 20000 per user', async () => {
  const s = await boot();
  const c = (await s.call('POST', '/api/register', creds('capper'))).cookie;
  const uid = s.db.prepare('SELECT id FROM users').get().id;
  s.db.exec('BEGIN');
  const ins = s.db.prepare("INSERT INTO hh_hands (user_id,site,hand_id,played_at,imported_at,players,norm_json) VALUES (?,?,?,?,?,?,'{}')");
  for (let i = 0; i < 19999; i++) ins.run(uid, 'pokerstars', `b${i}`, 1, 1, 2);
  s.db.exec('COMMIT');
  let r = await s.call('POST', '/api/hh', { hands: [hand('x1'), hand('x2')] }, c);
  assert.equal(r.status, 413); assert.equal(r.json.error, 'hand_cap');
  assert.equal((await s.call('POST', '/api/hh', { hands: [hand('x1')] }, c)).json.added, 1); // exactly 20000
  r = await s.call('POST', '/api/hh', { hands: [hand('x3')] }, c);
  assert.equal(r.status, 413);
  assert.equal(s.db.prepare('SELECT count(*) c FROM hh_hands').get().c, 20000);
  s.close();
});

test('approx_only decisions with values; status filters; from/to/site filters', async () => {
  const s = await boot({ hhRateLimit: { max: 1000, windowMs: 60000 } });
  const c = (await s.call('POST', '/api/register', creds('filt'))).cookie;
  await s.call('POST', '/api/hh', { hands: [hand('h1', { played_at: 1000 }), hand('h2', { played_at: 2000, site: 'ggpoker' }), hand('h3', { played_at: 3000 })] }, c);
  const ids = (r) => r.json.hands.map((h) => h.handId);
  assert.deepEqual(ids(await s.call('GET', '/api/hh?from=2000', undefined, c)), ['h3', 'h2']);
  assert.deepEqual(ids(await s.call('GET', '/api/hh?to=2000', undefined, c)), ['h2', 'h1']);
  assert.deepEqual(ids(await s.call('GET', '/api/hh?from=1500&to=2500', undefined, c)), ['h2']);
  assert.deepEqual(ids(await s.call('GET', '/api/hh?site=ggpoker', undefined, c)), ['h2']);
  assert.equal((await s.call('GET', '/api/hh?site=nope', undefined, c)).status, 400);
  assert.equal((await s.call('GET', '/api/hh?from=abc', undefined, c)).status, 400);
  const row = (await s.call('GET', '/api/hh?site=ggpoker', undefined, c)).json.hands[0].id;
  const ok = await s.call('POST', '/api/hh/decisions', { decisions: [dec(row, { solverFreqs: [0.5, 2], evLoss: 0.7 })] }, c);
  assert.equal(ok.status, 201);
  const g = (await s.call('GET', '/api/hh/decisions?status=approx_only', undefined, c)).json.decisions[0];
  assert.deepEqual(g.solverFreqs, [0.5, 2]); assert.equal(g.evLoss, 0.7);
  for (const bad of [{ solverFreqs: ['x'] }, { evLoss: -1 }, { solverFreqs: new Array(17).fill(0) }]) {
    assert.equal((await s.call('POST', '/api/hh/decisions', { decisions: [dec(row, bad)] }, c)).status, 400);
  }
  assert.equal((await s.call('POST', '/api/hh/decisions', { decisions: [dec(row, { status: 'off_tree', evLoss: 1 })] }, c)).status, 400);
  // approx_only rows never reach the hh progress (ok only)
  assert.equal((await s.call('GET', '/api/progress?source=hh', undefined, c)).json.byStatus.approx_only, 1);
  s.close();
});

test('static: serving, SPA fallback, traversal, headers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gto-static-'));
  const dist = join(root, 'dist'); mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html>INDEX</html>');
  writeFileSync(join(dist, 'assets', 'a.js'), 'console.log(1)');
  writeFileSync(join(root, 'secret.txt'), 'TOPSECRET');
  const s = await boot({ webDist: dist });
  let r = await s.raw('/assets/a.js');
  assert.equal(r.status, 200); assert.equal(r.text, 'console.log(1)');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /wasm-unsafe-eval/);
  assert.match(r.headers['content-security-policy'], /worker-src 'self'/);
  r = await s.raw('/some/spa/route'); assert.equal(r.status, 200); assert.equal(r.text, '<html>INDEX</html>');
  assert.equal((await s.raw('/assets/missing.js')).status, 404);
  assert.equal((await s.raw('/', 'HEAD')).status, 200);
  assert.equal((await s.raw('/x', 'POST')).status, 404);
  for (const p of ['/../secret.txt', '/../../etc/passwd', '/%2e%2e/secret.txt', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fsecret.txt',
    '/assets/../../secret.txt', '/..%5csecret.txt', '/%252e%252e/secret.txt', '/%00', '/assets/%00.js', '/%ff']) {
    r = await s.raw(p);
    assert.ok(!r.text.includes('TOPSECRET') && !r.text.includes('root:'), p);
    assert.ok([200, 400, 403, 404].includes(r.status), `${p} ${r.status}`);
    if (r.status === 200) assert.equal(r.text, '<html>INDEX</html>', p);
  }
  s.close();
});

test('session cleanup on login; expired session rejected and deleted', async () => {
  const s = await boot();
  const a = await s.call('POST', '/api/register', creds('sess'));
  await s.call('POST', '/api/register', creds('other'));
  assert.equal(s.db.prepare('SELECT count(*) c FROM sessions').get().c, 2);
  s.clock.t += 31 * 86400000;
  assert.equal((await s.call('GET', '/api/me', undefined, a.cookie)).status, 401);
  assert.equal(s.db.prepare('SELECT count(*) c FROM sessions').get().c, 1); // lazy delete
  await s.call('POST', '/api/login', creds('sess'));
  assert.equal(s.db.prepare('SELECT count(*) c FROM sessions').get().c, 1); // 'other' expired row purged, new one added
  s.close();
});

test('concurrent overlapping imports stay consistent', async () => {
  const s = await boot({ hhRateLimit: { max: 1000, windowMs: 60000 } });
  const c = (await s.call('POST', '/api/register', creds('conc'))).cookie;
  const batch = (a, b) => ({ hands: Array.from({ length: b - a }, (_, i) => hand(`c${a + i}`)) });
  const rs = await Promise.all([[0, 60], [30, 90], [0, 90], [60, 120], [10, 50], [0, 120]].map(([a, b]) => s.call('POST', '/api/hh', batch(a, b), c)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.reduce((n, r) => n + r.json.added, 0), 120);
  assert.equal(rs.reduce((n, r) => n + r.json.added + r.json.duplicates, 0), 60 + 60 + 90 + 60 + 40 + 120);
  assert.equal(s.db.prepare('SELECT count(*) c FROM hh_hands').get().c, 120);
  s.close();
});

test('body limits on every POST and no leaks in errors', async () => {
  const s = await boot();
  const c = (await s.call('POST', '/api/register', creds('limits'))).cookie;
  const big = { x: 'y'.repeat(20000) };
  for (const p of ['/api/register', '/api/login']) assert.equal((await s.call('POST', p, big)).status, 413, p);
  assert.equal((await s.call('POST', '/api/drills/results', big, c)).status, 413);
  const huge = { hands: [], pad: 'y'.repeat(2 * 1024 * 1024 + 10) };
  assert.equal((await s.call('POST', '/api/hh', huge, c)).status, 413);
  assert.equal((await s.call('POST', '/api/hh/decisions', huge, c)).status, 413);
  // errors are code-only
  for (const [m, p, b] of [['POST', '/api/login', { username: "x' OR 1=1 --", password: 'p' }], ['GET', '/api/hh?site=%27', undefined],
    ['GET', '/api/nope'], ['POST', '/api/hh', { hands: [{}] }]]) {
    const r = await s.call(m, p, b, c);
    assert.ok(r.status >= 400);
    assert.deepEqual(Object.keys(r.json), ['error'], p);
    assert.ok(!/stack|sqlite|SELECT|\bat \w/i.test(r.text), p);
  }
  // malformed raw JSON
  const r = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":' });
  assert.equal(r.status, 400);
  s.close();
});
