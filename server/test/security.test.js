import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
  const send = async (method, path, body, cookie, headers = {}, rawBody) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
    const sc = r.headers.get('set-cookie');
    return { status: r.status, json, text, headers: r.headers, setCookie: sc, cookie: sc ? sc.split(';')[0] : null };
  };
  return { db, srv, port, clock, call: send, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const creds = (u, p = 'password123') => ({ username: u, password: p });
const result = (o = {}) => ({ spotId: 'river:root:1', hero: 0, handCombo: 'AsKd', solverFreqs: [0.5, 0.5], action: 0, evLoss: 0.1, ms: 1000, ...o });
const reg = async (s, u = 'alice') => (await s.call('POST', '/api/register', creds(u))).cookie;

test('server timeouts are set', async () => {
  const s = await boot();
  assert.ok(s.srv.headersTimeout > 0 && s.srv.headersTimeout <= 30000);
  assert.ok(s.srv.requestTimeout > 0 && s.srv.requestTimeout <= 120000);
  assert.ok(s.srv.keepAliveTimeout >= 5000);
  s.close();
});

test('__proto__ / constructor keys in bodies do not pollute or bypass validation', async () => {
  const s = await boot();
  const r = await s.call('POST', '/api/register', undefined, undefined, { 'content-type': 'application/json' },
    '{"username":"proto1","password":"password123","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}');
  assert.equal(r.status, 201);
  assert.equal({}.polluted, undefined);
  const c = r.cookie;
  const d = await s.call('POST', '/api/drills/results', undefined, c, { 'content-type': 'application/json' },
    JSON.stringify(result()).replace('{', '{"__proto__":{"polluted":1},'));
  assert.equal(d.status, 201);
  assert.equal({}.polluted, undefined);
  s.close();
});

test('drill results reject poisoned numbers (1e308, Infinity, NaN-ish, negative, bad freqs)', async () => {
  const s = await boot(); const c = await reg(s);
  const post = (o) => s.call('POST', '/api/drills/results', result(o), c);
  for (const o of [{ evLoss: 1e308 }, { evLoss: -1 }, { evLoss: 1e6 + 1 }, { evLoss: null }, { evLoss: '1' },
    { solverFreqs: [0.5, 0.5, -0.0001] }, { solverFreqs: [2, -1] }, { solverFreqs: [0.2, 0.2] }, { solverFreqs: [] },
    { solverFreqs: Array(17).fill(1 / 17) }, { action: 5 }, { action: 0.5 }, { action: -1 }, { ms: -1 }, { ms: 1e12 },
    { hero: 2 }, { handCombo: 'AsAs\n' }, { spotId: 'x'.repeat(101) }, { spotId: "a'; DROP TABLE users;--" }, { spotId: '../etc' + ' ' }]) {
    assert.equal((await post(o)).status, 400, JSON.stringify(o).slice(0, 80));
  }
  // JSON.parse turns 1e999 into Infinity; must be rejected, not stored
  for (const raw of ['"evLoss":1e999', '"ms":1e999']) {
    const body = JSON.stringify(result()).replace(/"(evLoss|ms)":[^,}]+/, raw);
    assert.equal((await s.call('POST', '/api/drills/results', undefined, c, { 'content-type': 'application/json' }, body)).status, 400);
  }
  const p = await s.call('GET', '/api/progress', undefined, c);
  assert.equal(p.json.total, 0);
  s.close();
});

test('hand-history decisions: poisoned numbers rejected, stats stay finite', async () => {
  const s = await boot(); const c = await reg(s);
  const d = (o) => s.call('POST', '/api/hh/decisions', { decisions: [{ handRow: 1, street: 'river', nodePath: 'x', actionIdx: 0,
    status: 'ok', rangePreset: 'p', engineVer: '1', solverFreqs: [1], evLoss: 0, ...o }] }, c);
  // handRow 1 does not exist for this user: 404 after validation passes
  assert.equal((await d({})).status, 404);
  for (const o of [{ evLoss: 1e308 }, { evLoss: -1 }, { solverFreqs: [-1, 2] }, { solverFreqs: [0.3] }, { handRow: 1.5 },
    { handRow: -5 }, { actionIdx: 99 }, { street: '__proto__' }, { status: 'constructor' }]) {
    assert.equal((await d(o)).status, 400, JSON.stringify(o));
  }
  const body = JSON.stringify({ decisions: [{ handRow: 1, street: 'river', nodePath: 'x', actionIdx: 0, status: 'ok',
    rangePreset: 'p', engineVer: '1', solverFreqs: [1], evLoss: 1e999 }] });
  assert.equal((await s.call('POST', '/api/hh/decisions', undefined, c, { 'content-type': 'application/json' }, body)).status, 400);
  const p = (await s.call('GET', '/api/progress?source=hh', undefined, c)).json;
  assert.ok(p.meanEvLoss === null || Number.isFinite(p.meanEvLoss));
  s.close();
});

test('usernames are ASCII-only: homoglyph, full-width, Turkish dotted I and Kelvin sign cannot alias', async () => {
  const s = await boot();
  assert.equal((await s.call('POST', '/api/register', creds('kevin'))).status, 201);
  for (const u of ['Kevin', 'ｋevin', 'kevın', 'İvan', 'аlice', 'ali‮ce', 'kevin\n', ' kevin', 'kev\u0000in']) {
    assert.equal((await s.call('POST', '/api/register', creds(u))).status, 400, JSON.stringify(u));
  }
  // Kelvin sign lowercases to "k" in JS: login must not resolve it to "kevin"
  const l = await s.call('POST', '/api/login', creds('Kevin'));
  assert.equal(l.status, 401);
  assert.equal((await s.call('POST', '/api/register', creds('KEVIN'))).status, 409);
  s.close();
});

test('SQL metacharacters in usernames, filters and ids are inert', async () => {
  const s = await boot(); const c = await reg(s);
  assert.equal((await s.call('POST', '/api/login', creds("' OR '1'='1"))).status, 401);
  assert.equal((await s.call('POST', '/api/login', { username: "x' OR 1=1 --", password: "' OR '1'='1" })).status, 401);
  for (const q of ["status=ok' OR 1=1--", "street=river;DROP TABLE users", "minEvLoss=1;DROP", "limit=1;DROP", "from=1 OR 1=1"]) {
    assert.equal((await s.call('GET', `/api/hh?${encodeURIComponent(q).replace(/%3D/, '=')}`, undefined, c)).status, 400, q);
  }
  assert.equal((await s.call('GET', '/api/hh/1%20OR%201=1', undefined, c)).status, 404);
  assert.equal((await s.call('GET', '/api/me', undefined, c)).status, 200); // users table intact
  s.close();
});

test('login timing path: unknown user and wrong password both run the KDF and return identical bodies', async () => {
  const s = await boot({ rateLimit: { max: 100, windowMs: 60000 } });
  await reg(s, 'bob');
  const time = async (u) => { const t = process.hrtime.bigint(); const r = await s.call('POST', '/api/login', creds(u, 'wrongpass1')); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
  await time('bob'); // warm up (also the lazily awaited dummy hash)
  const a = await time('bob'); const b = await time('nobody');
  assert.deepEqual(a.r.json, b.r.json); assert.equal(a.r.status, b.r.status);
  assert.ok(b.ms > 5, `unknown user must still pay the scrypt cost (${b.ms}ms)`);
  s.close();
});

test('login per-IP limiter caps username spraying', async () => {
  const s = await boot({ rateLimit: { max: 2, windowMs: 60000 } });
  let last;
  for (let i = 0; i < 21; i++) last = await s.call('POST', '/api/login', creds(`user${i}`, 'badbadbad'));
  assert.equal(last.status, 429);
  s.close();
});

test('sessions: new token per login, logout and delete invalidate server-side, cookie attrs', async () => {
  const s = await boot();
  const r = await s.call('POST', '/api/register', creds('carol'));
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Lax/); assert.match(r.setCookie, /Path=\//);
  // attacker-chosen (fixated) cookie is never adopted
  const l = await s.call('POST', '/api/login', creds('carol'), 'sid=attackerchosen');
  assert.notEqual(l.cookie, 'sid=attackerchosen'); assert.notEqual(l.cookie, r.cookie);
  assert.equal((await s.call('GET', '/api/me', undefined, 'sid=attackerchosen')).status, 401);
  await s.call('POST', '/api/logout', {}, l.cookie);
  assert.equal((await s.call('GET', '/api/me', undefined, l.cookie)).status, 401); // replaying the old token fails
  assert.equal((await s.call('GET', '/api/me', undefined, r.cookie)).status, 200); // other session unaffected
  s.close();
});

test('CSRF: non-JSON content types rejected, no CORS headers, preflight grants nothing', async () => {
  const s = await boot(); const c = await reg(s);
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', '']) {
    const r = await s.call('POST', '/api/drills/results', undefined, c, ct ? { 'content-type': ct } : {}, JSON.stringify(result()));
    assert.equal(r.status, 415, ct);
  }
  assert.equal((await s.call('POST', '/api/logout', undefined, c, { 'content-type': 'text/plain' })).status, 200); // logout needs no body; harmless
  const p = await s.call('OPTIONS', '/api/drills/results', undefined, undefined,
    { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' });
  for (const k of ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods']) assert.equal(p.headers.get(k), null);
  const g = await s.call('GET', '/api/me', undefined, c, { origin: 'https://evil.example' });
  assert.equal(g.headers.get('access-control-allow-origin'), null);
  s.close();
});

test('POST /api/me/password: needs current password, rotates hash, kills other sessions only', async () => {
  const s = await boot();
  const a = await s.call('POST', '/api/register', creds('dana'));
  const b = await s.call('POST', '/api/login', creds('dana'));
  const url = '/api/me/password';
  assert.equal((await s.call('POST', url, { currentPassword: 'password123', newPassword: 'x' }, a.cookie)).status, 400);
  assert.equal((await s.call('POST', url, { currentPassword: 'wrongwrong', newPassword: 'newpassword1' }, a.cookie)).status, 403);
  assert.equal((await s.call('POST', url, { newPassword: 'newpassword1' }, a.cookie)).status, 403);
  assert.equal((await s.call('POST', url, { currentPassword: 'password123', newPassword: 'newpassword1' })).status, 401);
  assert.equal((await s.call('POST', url, { currentPassword: 'password123', newPassword: 'newpassword1' }, a.cookie)).status, 200);
  assert.equal((await s.call('GET', '/api/me', undefined, a.cookie)).status, 200);
  assert.equal((await s.call('GET', '/api/me', undefined, b.cookie)).status, 401);
  assert.equal((await s.call('POST', '/api/login', creds('dana', 'password123'))).status, 401);
  assert.equal((await s.call('POST', '/api/login', creds('dana', 'newpassword1'))).status, 200);
  s.close();
});

test('DELETE /api/me: password re-entry, removes account + all data + sessions, name reusable', async () => {
  const s = await boot();
  const a = await s.call('POST', '/api/register', creds('erin'));
  const b = await s.call('POST', '/api/login', creds('erin'));
  await s.call('POST', '/api/drills/results', result(), a.cookie);
  assert.equal((await s.call('DELETE', '/api/me', undefined, a.cookie)).status, 415);
  assert.equal((await s.call('DELETE', '/api/me', { password: 'wrongwrong' }, a.cookie)).status, 403);
  assert.equal((await s.call('DELETE', '/api/me', { password: 'password123' })).status, 401);
  assert.equal((await s.call('GET', '/api/me', undefined, a.cookie)).status, 200);
  const d = await s.call('DELETE', '/api/me', { password: 'password123' }, a.cookie);
  assert.equal(d.status, 200); assert.match(d.setCookie, /Max-Age=0/);
  for (const t of ['users', 'sessions', 'drill_results', 'hh_hands', 'hh_decisions']) assert.equal(s.db.prepare(`SELECT count(*) c FROM ${t}`).get().c, 0, t);
  assert.equal((await s.call('GET', '/api/me', undefined, b.cookie)).status, 401);
  assert.equal((await s.call('POST', '/api/login', creds('erin'))).status, 401);
  assert.equal((await s.call('POST', '/api/register', creds('erin'))).status, 201);
  s.close();
});

test('oversized URL / header -> 431, never crashes; db failure -> JSON 500', async () => {
  const s = await boot(); const c = await reg(s);
  const r = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port: s.port, path: '/api/me?' + 'a'.repeat(70000) }, (x) => { x.resume(); res(x.statusCode); });
    q.on('error', () => res('closed')); q.end();
  });
  assert.ok(r === 431 || r === 'closed', String(r));
  assert.equal((await s.call('GET', '/api/me', undefined, c, { 'x-big': 'a'.repeat(1000) })).status, 200);
  s.db.close(); // simulates a broken/locked DB handle
  const e = await s.call('GET', '/api/me', undefined, c);
  assert.equal(e.status, 500); assert.deepEqual(e.json, { error: 'internal' });
  s.close();
});

test('SIGTERM: logs version + db path, drains and exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gto-sig-'));
  const dbp = join(dir, 'app.db');
  const port = 40000 + Math.floor(Math.random() * 2000);
  const p = spawn(process.execPath, ['src/index.js'], { cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), DB_PATH: dbp } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('listening'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /gto-server v\d+\.\d+\.\d+ listening on \d+ db=/); assert.ok(out.includes(dbp));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  const code = await new Promise((r) => { p.on('exit', (c, sig) => r(c ?? sig)); p.kill('SIGTERM'); });
  assert.equal(code, 0);
  assert.match(out, /SIGTERM received/);
});
