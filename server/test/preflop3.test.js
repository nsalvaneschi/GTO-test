import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';

async function boot() {
  const db = openDb(':memory:');
  const srv = createApp({ db, now: () => Date.UTC(2026, 5, 15, 12) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, cookie) => {
    const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
    const sc = r.headers.get('set-cookie');
    return { status: r.status, json, cookie: sc ? sc.split(';')[0] : null };
  };
  return { db, call, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const reg = (s, u) => s.call('POST', '/api/register', { username: u, password: 'password123' });
const meta = (o = {}) => ({ packId: 'SYNTH_20', verification: 'test-fixture', verdict: 'correct', evKnown: false, ...o });
const p3 = (o = {}) => ({ spotId: 'preflop3:20:n1:SB', hero: 1, handCombo: 'AsKd', action: 0, solverFreqs: [0.6, 0.4], evLoss: 0, ms: 900, lang: 'en', meta: meta(), ...o });
const river = { spotId: 'river:root:AsKd7c4h2s:x:root', hero: 0, handCombo: 'AsKd', action: 0, solverFreqs: [1], evLoss: 0.2, ms: 5 };

test('preflop3 result round-trips with meta and aggregates by verdict in its own group', async () => {
  const s = await boot();
  const a = await reg(s, 'usera'), b = await reg(s, 'userb');
  for (const v of ['correct', 'correct', 'close', 'incorrect'])
    assert.equal((await s.call('POST', '/api/drills/results', p3({ meta: meta({ verdict: v }) }), a.cookie)).status, 201);
  assert.equal((await s.call('POST', '/api/drills/results', river, a.cookie)).status, 201);
  const row = s.db.prepare("SELECT spot_type, hero, meta FROM drill_results WHERE spot_type='preflop3' LIMIT 1").get();
  assert.equal(row.hero, 1); assert.deepEqual(JSON.parse(row.meta), meta({ verdict: 'correct' }));
  assert.equal(s.db.prepare("SELECT meta FROM drill_results WHERE spot_type='river:root'").get().meta, null);
  const p = (await s.call('GET', '/api/progress?source=preflop3', undefined, a.cookie)).json;
  assert.deepEqual(p, { source: 'preflop3', total: 4, correct: 2, close: 1, incorrect: 1, accuracy: 0.5 });
  const d = (await s.call('GET', '/api/progress', undefined, a.cookie)).json; // drills totals never include preflop3
  assert.equal(d.total, 1); assert.deepEqual(d.bySpotType.map((t) => t.spotType), ['river:root']);
  assert.equal((await s.call('GET', '/api/progress?source=hh', undefined, a.cookie)).json.total, 0);
  assert.deepEqual((await s.call('GET', '/api/progress?source=preflop3', undefined, b.cookie)).json, { source: 'preflop3', total: 0, correct: 0, close: 0, incorrect: 0, accuracy: null });
  assert.equal((await s.call('GET', '/api/progress?source=preflop3')).status, 401);
  s.close();
});

test('preflop3 input bounds', async () => {
  const s = await boot();
  const a = await reg(s, 'usera');
  const post = (o) => s.call('POST', '/api/drills/results', p3(o), a.cookie);
  assert.equal((await post({ hero: 2, spotId: 'preflop3:16:n0:BB' })).status, 201);
  assert.equal((await s.call('POST', '/api/drills/results', { ...river, hero: 2 }, a.cookie)).status, 400); // 3 seats only for preflop3
  const bads = [{ meta: undefined }, { meta: null }, { meta: [] }, { meta: meta({ verdict: 'great' }) }, { meta: meta({ verification: 'gto' }) },
    { meta: meta({ packId: 'x'.repeat(65) }) }, { meta: meta({ packId: 'a b' }) }, { meta: { ...meta(), extra: 'x'.repeat(5000) } }, { meta: meta({ evKnown: 'yes' }) },
    { spotId: 'preflop3:20:n1:UTG' }, { spotId: 'preflop3:20:n1' }, { spotId: 'preflop3:200:n1:SB' }, { spotId: 'preflop3:20:n1:SB:x' }, { hero: 3 }];
  for (const b of bads) assert.equal((await post(b)).status, 400, JSON.stringify(b).slice(0, 80));
  // meta on a non-preflop3 spot is allowed but validated
  assert.equal((await s.call('POST', '/api/drills/results', { ...river, meta: meta() }, a.cookie)).status, 201);
  assert.equal((await s.call('POST', '/api/drills/results', { ...river, meta: { verdict: 'x' } }, a.cookie)).status, 400);
  assert.equal((await s.call('GET', '/api/progress?source=bogus', undefined, a.cookie)).status, 400);
  s.close();
});

test('meta migration is idempotent and keeps data on a pre-populated DB', () => {
  const path = mkdtempSync(tmpdir() + '/gto-mig3-') + '/app.db';
  let db = openDb(path);
  db.exec('ALTER TABLE drill_results DROP COLUMN meta; PRAGMA user_version = 3;'); // the DB as it was before this migration
  db.exec(`INSERT INTO users (username, username_lc, pw_hash, created_at) VALUES ('Old','old','x',1);
    INSERT INTO drill_results (user_id, spot_id, spot_type, hero, hand_combo, action, solver_freqs, ev_loss, ms, created_at)
      VALUES (1,'rfi:btn','rfi',0,'AsKd',0,'[1]',0.1,10,5);`);
  db.close();
  db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  const r = db.prepare('SELECT spot_id, meta FROM drill_results').all();
  assert.deepEqual(r.map((x) => [x.spot_id, x.meta]), [['rfi:btn', null]]);
  migrate(db); migrate(db);
  db.exec('PRAGMA user_version = 3'); // column already there but version behind: must not throw
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(db.prepare('SELECT count(*) c FROM drill_results').get().c, 1);
  db.close();
});
