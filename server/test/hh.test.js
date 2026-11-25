import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';

async function boot(opts = {}) {
  const db = opts.db ?? openDb(':memory:');
  const srv = createApp({ db, now: () => Date.UTC(2026, 5, 15, 12), ...opts });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, cookie) => {
    const r = await fetch(base + path, { method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch {}
    const sc = r.headers.get('set-cookie');
    return { status: r.status, json, cookie: sc ? sc.split(';')[0] : null };
  };
  const user = async (name) => (await call('POST', '/api/register', { username: name, password: 'password123' })).cookie;
  return { db, call, user, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const H = 'a'.repeat(64);
const hand = (id, o = {}) => ({ site: 'pokerstars', hand_id: id, played_at: 1700000000000, stakes: { sb: 0.5, bb: 1 },
  seats: [{ seat: 1, name_hash: H, stack: 100, is_hero: true }, { seat: 2, name_hash: 'b'.repeat(64), stack: 100, is_hero: false }],
  hero_cards: ['As', 'Kd'], board: ['2c', '7d', 'Th', 'Js', '3s'],
  actions: [{ street: 'river', seat: 2, kind: 'bet', amount_to: 10 }, { street: 'river', seat: 1, kind: 'call', amount_to: 10 }],
  pot_by_street: [3, 6, 6, 6], hero_pos: 'BTN', ...o });
const dec = (handRow, o = {}) => ({ handRow, street: 'river', nodePath: 'x:b50', actionIdx: 0, status: 'ok',
  solverFreqs: [0.6, 0.4], evLoss: 1.5, rangePreset: 'srp-btn-bb', engineVer: '0.1', ...o });
const drill = { spotId: 'rfi:btn', hero: 0, handCombo: 'AsKd', action: 0, solverFreqs: [0.7, 0.3], evLoss: 0.5, ms: 1200 };

test('unauthenticated requests get 401', async () => {
  const s = await boot();
  for (const [m, p] of [['POST', '/api/hh'], ['GET', '/api/hh'], ['GET', '/api/hh/1'], ['POST', '/api/hh/decisions'],
    ['GET', '/api/hh/decisions'], ['DELETE', '/api/hh'], ['DELETE', '/api/me/data'], ['GET', '/api/progress?source=hh']]) {
    assert.equal((await s.call(m, p, m === 'POST' ? { hands: [] } : undefined)).status, 401, `${m} ${p}`);
  }
  s.close();
});

test('duplicate import is idempotent; raw text only on opt-in; names never stored', async () => {
  const s = await boot();
  const c = await s.user('alice');
  const withName = { ...hand('100'), raw_text: 'SECRET RAW', seats: [{ seat: 1, name_hash: H, stack: 100, is_hero: true, name: 'Villain9' },
    { seat: 2, name_hash: 'b'.repeat(64), stack: 100, is_hero: false }] };
  let r = await s.call('POST', '/api/hh', { hands: [withName, hand('101')] }, c);
  assert.deepEqual([r.status, r.json], [200, { added: 2, duplicates: 0 }]);
  r = await s.call('POST', '/api/hh', { hands: [hand('100'), hand('101'), hand('102')] }, c);
  assert.deepEqual(r.json, { added: 1, duplicates: 2 });
  assert.equal((await s.call('GET', '/api/hh', undefined, c)).json.total, 3);
  const dump = s.db.prepare('SELECT group_concat(norm_json) j, count(raw_text) r FROM hh_hands').get();
  assert.ok(!dump.j.includes('Villain9'));
  assert.equal(dump.r, 0);
  await s.call('POST', '/api/hh', { keepRaw: true, hands: [{ ...hand('103'), raw_text: 'KEEP' }] }, c);
  assert.equal(s.db.prepare("SELECT raw_text FROM hh_hands WHERE hand_id='103'").get().raw_text, 'KEEP');
  s.close();
});

test('cross-user access returns 404 and lists are scoped', async () => {
  const s = await boot();
  const a = await s.user('alice'), b = await s.user('bobby');
  await s.call('POST', '/api/hh', { hands: [hand('1')] }, a);
  const id = (await s.call('GET', '/api/hh', undefined, a)).json.hands[0].id;
  assert.equal((await s.call('GET', `/api/hh/${id}`, undefined, a)).status, 200);
  assert.equal((await s.call('GET', `/api/hh/${id}`, undefined, b)).status, 404);
  assert.equal((await s.call('POST', '/api/hh/decisions', { decisions: [dec(id)] }, b)).status, 404);
  assert.equal((await s.call('GET', '/api/hh', undefined, b)).json.total, 0);
  // same hand id for another user is not a duplicate
  assert.equal((await s.call('POST', '/api/hh', { hands: [hand('1')] }, b)).json.added, 1);
  assert.equal((await s.call('DELETE', '/api/hh', undefined, b)).json.hands, 1);
  assert.equal((await s.call('GET', `/api/hh/${id}`, undefined, a)).status, 200);
  s.close();
});

test('size limits give 413, malformed gives 400', async () => {
  const s = await boot({ hhMaxHands: 3 });
  const c = await s.user('alice');
  const many = Array.from({ length: 501 }, (_, i) => hand(String(i)));
  assert.equal((await s.call('POST', '/api/hh', { hands: many }, c)).status, 413);
  assert.equal((await s.call('POST', '/api/hh', { hands: [hand('1', { board: ['2c'] }), { ...hand('2'), seats: [] }] }, c)).status, 400);
  const big = await s.call('POST', '/api/hh', { hands: [hand('9', { actions: [] })], pad: 'x'.repeat(2.1 * 1024 * 1024) }, c);
  assert.equal(big.status, 413);
  assert.equal((await s.call('POST', '/api/hh', { keepRaw: true, hands: [{ ...hand('8'), raw_text: 'x'.repeat(65 * 1024) }] }, c)).status, 413);
  for (const bad of [hand('1', { site: 'foo' }), hand('1', { hand_id: 'a b' }), hand('1', { seats: [{ seat: 1, name_hash: 'Villain', stack: 1, is_hero: true }, { seat: 2, name_hash: H, stack: 1, is_hero: false }] }),
    hand('1', { actions: [{ street: 'river', seat: 1, kind: 'xx' }] }), hand('1', { played_at: 'now' })]) {
    assert.equal((await s.call('POST', '/api/hh', { hands: [bad] }, c)).status, 400);
  }
  assert.equal((await s.call('POST', '/api/hh', { hands: 'nope' }, c)).status, 400);
  assert.equal((await s.call('GET', '/api/hh?limit=abc', undefined, c)).status, 400);
  // per-user cap (3)
  assert.equal((await s.call('POST', '/api/hh', { hands: [hand('1'), hand('2'), hand('3')] }, c)).status, 200);
  assert.equal((await s.call('POST', '/api/hh', { hands: [hand('4')] }, c)).status, 413);
  s.close();
});

test('upload rate limit gives 429', async () => {
  const s = await boot({ hhRateLimit: { max: 2, windowMs: 60000 } });
  const c = await s.user('alice');
  assert.equal((await s.call('POST', '/api/hh', { hands: [hand('1')] }, c)).status, 200);
  assert.equal((await s.call('POST', '/api/hh', { hands: [hand('2')] }, c)).status, 200);
  assert.equal((await s.call('POST', '/api/hh', { hands: [hand('3')] }, c)).status, 429);
  s.close();
});

test('decisions: validation, replace, filters, hh progress separate from drills', async () => {
  const s = await boot();
  const c = await s.user('alice');
  await s.call('POST', '/api/hh', { hands: [hand('1'), hand('2')] }, c);
  const [h2, h1] = (await s.call('GET', '/api/hh', undefined, c)).json.hands.map((h) => h.id);
  assert.equal((await s.call('POST', '/api/hh/decisions', { decisions: [dec(h1, { status: 'bogus' })] }, c)).status, 400);
  assert.equal((await s.call('POST', '/api/hh/decisions', { decisions: [dec(h1, { solverFreqs: [0.9, 0.9] })] }, c)).status, 400);
  assert.equal((await s.call('POST', '/api/hh/decisions', { decisions: [dec(h1, { status: 'off_tree', reason: 'off_tree', evLoss: 3 })] }, c)).status, 400);
  const ok = await s.call('POST', '/api/hh/decisions', { decisions: [dec(h1), dec(h2, { evLoss: 4, actionIdx: 1 }),
    dec(h2, { nodePath: 'y', status: 'multiway'.length ? 'unsupported' : 'ok', reason: 'multiway', solverFreqs: null, evLoss: null })] }, c);
  assert.equal(ok.status, 201);
  // re-analysis replaces the same node
  await s.call('POST', '/api/hh/decisions', { decisions: [dec(h1, { evLoss: 2 })] }, c);
  const all = (await s.call('GET', '/api/hh/decisions', undefined, c)).json;
  assert.equal(all.total, 3);
  assert.equal((await s.call('GET', '/api/hh/decisions?status=ok&minEvLoss=3', undefined, c)).json.total, 1);
  assert.equal((await s.call('GET', '/api/hh?status=unsupported', undefined, c)).json.total, 1);
  assert.equal((await s.call('GET', '/api/hh?minEvLoss=10', undefined, c)).json.total, 0);
  assert.equal((await s.call('GET', `/api/hh/${h1}`, undefined, c)).json.decisions.length, 1);

  await s.call('POST', '/api/drills/results', drill, c);
  const before = (await s.call('GET', '/api/progress', undefined, c)).json;
  assert.equal(before.total, 1);
  assert.equal(before.source, undefined);
  const hh = (await s.call('GET', '/api/progress?source=hh', undefined, c)).json;
  assert.equal(hh.source, 'hh');
  assert.equal(hh.total, 2); // ok only
  assert.equal(hh.meanEvLoss, 3);
  assert.deepEqual(hh.byStatus, { ok: 2, unsupported: 1 });
  assert.deepEqual((await s.call('GET', '/api/progress', undefined, c)).json, before);
  assert.equal((await s.call('GET', '/api/progress?source=zzz', undefined, c)).status, 400);
  s.close();
});

test('DELETE /api/hh cascades to decisions; DELETE /api/me/data also wipes drills and keeps account', async () => {
  const s = await boot();
  const c = await s.user('alice');
  const seed = async () => {
    await s.call('POST', '/api/hh', { hands: [hand('1')] }, c);
    const id = (await s.call('GET', '/api/hh', undefined, c)).json.hands[0].id;
    await s.call('POST', '/api/hh/decisions', { decisions: [dec(id)] }, c);
    await s.call('POST', '/api/drills/results', drill, c);
  };
  const n = (t) => s.db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
  await seed();
  assert.deepEqual((await s.call('DELETE', '/api/hh', undefined, c)).json, { hands: 1, decisions: 1 });
  assert.deepEqual([n('hh_hands'), n('hh_decisions'), n('drill_results')], [0, 0, 1]);
  await seed();
  assert.deepEqual((await s.call('DELETE', '/api/me/data', undefined, c)).json, { hands: 1, decisions: 1, drillResults: 2 });
  assert.deepEqual([n('hh_hands'), n('hh_decisions'), n('drill_results'), n('users')], [0, 0, 0, 1]);
  assert.equal((await s.call('GET', '/api/me', undefined, c)).status, 200);
  s.close();
});

test('migration on an existing DB with drill data is idempotent and keeps data', async () => {
  const dir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/gto-mig-');
  const path = `${dir}/app.db`;
  // Build a v2 DB (before HH) with data, using the original two migrations.
  let db = openDb(path);
  db.exec('PRAGMA foreign_keys = OFF; DROP TABLE hh_decisions; DROP TABLE hh_hands; PRAGMA user_version = 2;');
  db.exec(`CREATE TABLE hand_histories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, raw_text TEXT NOT NULL, imported_at INTEGER NOT NULL);
    INSERT INTO users (username, username_lc, pw_hash, created_at) VALUES ('Old','old','x',1);
    INSERT INTO drill_results (user_id, spot_id, spot_type, hero, hand_combo, action, solver_freqs, ev_loss, ms, created_at)
      VALUES (1,'rfi:btn','rfi',0,'AsKd',0,'[1]',0.1,10,5);`);
  db.close();
  db = openDb(path); // runs the HH migration
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4); // latest migration (preflop3 meta column)
  assert.equal(db.prepare('SELECT count(*) c FROM drill_results').get().c, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='hand_histories'").get().c, 0);
  assert.equal(db.prepare("SELECT count(*) c FROM sqlite_master WHERE name IN ('hh_hands','hh_decisions')").get().c, 2);
  migrate(db); migrate(db); // idempotent
  db.close();
  db = openDb(path);
  assert.equal(db.prepare('SELECT count(*) c FROM drill_results').get().c, 1);
  db.close();
});
