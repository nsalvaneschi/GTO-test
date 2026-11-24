import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { summarize } from '../src/stats.js';

async function boot(opts = {}) {
  const db = openDb(':memory:');
  const clock = { t: Date.UTC(2026, 5, 15, 12) };
  const srv = createApp({ db, now: () => clock.t, ...opts });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, cookie, raw) => {
    const r = await fetch(base + path, { method, redirect: 'manual',
      headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch {}
    const sc = r.headers.get('set-cookie');
    return { status: r.status, json, setCookie: sc, cookie: sc ? sc.split(';')[0] : null };
  };
  return { db, clock, base, call, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const creds = (u = 'Alice', p = 'password123') => ({ username: u, password: p });
const result = (o = {}) => ({ spotId: 'rfi:btn', hero: 0, handCombo: 'AsKd', action: 0,
  solverFreqs: [0.7, 0.3], evLoss: 0.5, ms: 1200, lang: 'en', ...o });

test('register/me/logout/login happy path + cookie flags', async () => {
  const s = await boot();
  const r = await s.call('POST', '/api/register', creds());
  assert.equal(r.status, 201);
  for (const f of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) assert.ok(r.setCookie.includes(f), f);
  assert.ok(!r.setCookie.includes('Secure'));
  assert.equal((await s.call('GET', '/api/me', undefined, r.cookie)).json.username, 'Alice');
  // token stored hashed
  const tok = r.cookie.split('=')[1];
  assert.equal(s.db.prepare('SELECT count(*) c FROM sessions WHERE token_hash = ?').get(tok).c, 0);
  assert.equal((await s.call('POST', '/api/logout', undefined, r.cookie)).status, 200);
  assert.equal((await s.call('GET', '/api/me', undefined, r.cookie)).status, 401);
  const l = await s.call('POST', '/api/login', creds('ALICE'));
  assert.equal(l.status, 200);
  assert.equal((await s.call('GET', '/api/me', undefined, l.cookie)).status, 200);
  s.close();
});

test('Secure flag when behind https proxy', async () => {
  const s = await boot();
  const r = await fetch(s.base + '/api/register', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify(creds('harry')) });
  assert.ok(r.headers.get('set-cookie').includes('; Secure'));
  s.close();
});

test('duplicate username is case-insensitive', async () => {
  const s = await boot();
  assert.equal((await s.call('POST', '/api/register', creds('Bob'))).status, 201);
  assert.equal((await s.call('POST', '/api/register', creds('bOB'))).status, 409);
  s.close();
});

test('wrong password and unknown user give identical errors', async () => {
  const s = await boot();
  await s.call('POST', '/api/register', creds('carol'));
  const a = await s.call('POST', '/api/login', creds('carol', 'wrongwrong'));
  const b = await s.call('POST', '/api/login', creds('nobody', 'wrongwrong'));
  assert.equal(a.status, 401);
  assert.deepEqual([a.status, a.json], [b.status, b.json]);
  s.close();
});

test('login rate limit per IP+username', async () => {
  const s = await boot({ rateLimit: { max: 3, windowMs: 60000 } });
  await s.call('POST', '/api/register', creds('dave'));
  for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/api/login', creds('dave', 'badbadbad'))).status, 401);
  assert.equal((await s.call('POST', '/api/login', creds('dave'))).status, 429); // even correct pw blocked
  assert.equal((await s.call('POST', '/api/login', creds('erin', 'badbadbad'))).status, 401); // other user ok
  s.clock.t += 61000;
  assert.equal((await s.call('POST', '/api/login', creds('dave'))).status, 200);
  s.close();
});

test('expired session is rejected', async () => {
  const s = await boot();
  const r = await s.call('POST', '/api/register', creds('frank'));
  s.clock.t += 30 * 86400000 + 1000;
  assert.equal((await s.call('GET', '/api/me', undefined, r.cookie)).status, 401);
  s.close();
});

test('input validation', async () => {
  const s = await boot();
  for (const u of ['ab', 'a'.repeat(25), 'bad name', 'né!', 5, undefined])
    assert.equal((await s.call('POST', '/api/register', { username: u, password: 'password123' })).status, 400, String(u));
  for (const p of ['short', 'x'.repeat(129), 12345678, undefined])
    assert.equal((await s.call('POST', '/api/register', { username: 'gina', password: p })).status, 400);
  assert.equal((await s.call('POST', '/api/register', undefined, undefined, '{bad json')).status, 400);
  const r = await s.call('POST', '/api/register', creds('gina'));
  const post = (b, raw) => s.call('POST', '/api/drills/results', b, r.cookie, raw);
  assert.equal((await post(undefined, '{oops')).status, 400);
  assert.equal((await post(undefined, '[1]')).status, 400);
  assert.equal((await s.call('POST', '/api/drills/results', result())).status, 401);
  assert.equal((await post(result())).status, 201);
  const bads = [{ spotId: '' }, { spotId: 'a b' }, { hero: 2 }, { handCombo: 'AsAs1' }, { handCombo: 'xx' },
    { solverFreqs: [0.5, 0.2] }, { solverFreqs: [] }, { solverFreqs: [1.5, -0.5] }, { solverFreqs: new Array(17).fill(1 / 17) },
    { action: 2 }, { action: -1 }, { action: 0.5 }, { evLoss: -1 }, { evLoss: 'x' }, { ms: -5 }, { ms: 1e9 }, { lang: 'fr' },
    { solverFreqs: ['0.5', '0.5'] }];
  for (const b of bads) assert.equal((await post(result(b))).status, 400, JSON.stringify(b));
  assert.equal((await post(undefined, JSON.stringify(result({ spotId: 'x'.repeat(20000) })))).status, 413);
  s.close();
});

test('per-user isolation', async () => {
  const s = await boot();
  const a = await s.call('POST', '/api/register', creds('usera'));
  const b = await s.call('POST', '/api/register', creds('userb'));
  await s.call('POST', '/api/drills/results', result(), a.cookie);
  await s.call('POST', '/api/drills/results', result(), a.cookie);
  assert.equal((await s.call('GET', '/api/progress', undefined, a.cookie)).json.total, 2);
  assert.equal((await s.call('GET', '/api/progress', undefined, b.cookie)).json.total, 0);
  assert.equal((await s.call('GET', '/api/progress')).status, 401);
  s.close();
});

test('accuracy / streak / series math on fixed data', () => {
  const DAY = 86400000;
  const now = Date.UTC(2026, 5, 15, 12);
  const row = (daysAgo, action, freqs, ev, type = 'rfi') => ({ spot_type: type, action, solver_freqs: JSON.stringify(freqs),
    ev_loss: ev, created_at: now - daysAgo * DAY });
  const rows = [
    row(0, 0, [0.7, 0.3], 0),     // correct
    row(0, 1, [0.95, 0.05], 2),   // wrong (<0.1)
    row(1, 1, [0.9, 0.1], 1),     // correct (exactly 0.1)
    row(2, 0, [1, 0], 0),         // correct
    row(4, 0, [1, 0], 0, '3bet'), // gap at day 3 -> streak stops
  ];
  const r = summarize(rows, now);
  assert.equal(r.total, 5);
  assert.equal(r.accuracy, 0.8);
  assert.equal(r.meanEvLoss, 0.6);
  assert.equal(r.streak, 3);
  assert.equal(r.last30Days.length, 30);
  assert.deepEqual(r.last30Days[29], { date: '2026-06-15', total: 2, accuracy: 0.5, meanEvLoss: 1 });
  assert.equal(r.last30Days[26].total, 0);
  assert.deepEqual(r.bySpotType.map((t) => [t.spotType, t.total]), [['3bet', 1], ['rfi', 4]]);
  // streak survives with nothing yet today; broken if nothing yesterday either
  assert.equal(summarize([row(1, 0, [1], 0), row(2, 0, [1], 0)], now).streak, 2);
  assert.equal(summarize([row(2, 0, [1], 0)], now).streak, 0);
  assert.equal(summarize([], now).accuracy, null);
});
