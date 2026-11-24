import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const big = 'export const x = "' + 'abcdefghij'.repeat(500) + '";\n';
const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d]), Buffer.alloc(4000, 7)]);
const png = Buffer.alloc(3000, 9);

async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'gto-st-'));
  const dist = join(root, 'dist'); mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html>' + 'x'.repeat(2000) + '</html>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), big);
  writeFileSync(join(dist, 'assets', 'solver-abc123.wasm'), wasm);
  writeFileSync(join(dist, 'assets', 'pic.png'), png);
  writeFileSync(join(dist, 'assets', 'tiny.js'), 'a=1');
  const srv = createApp({ db: openDb(':memory:'), webDist: dist });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  // http.request does not auto-decompress, so bytes are exactly what is on the wire.
  const get = (path, headers = {}, method = 'GET') => new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port, path, method, headers }, (r) => {
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) }));
    }); q.on('error', rej); q.end();
  });
  return { get, close: () => { srv.closeAllConnections(); srv.close(); } };
}

test('static: gzip and brotli negotiation round-trip', async () => {
  const s = await boot();
  let r = await s.get('/assets/app-abc123.js', { 'accept-encoding': 'gzip' });
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.match(r.headers.vary, /Accept-Encoding/);
  assert.equal(Number(r.headers['content-length']), r.body.length);
  assert.ok(r.body.length < big.length);
  assert.equal(gunzipSync(r.body).toString(), big);
  r = await s.get('/assets/app-abc123.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(r.headers['content-encoding'], 'br');
  assert.equal(brotliDecompressSync(r.body).toString(), big);
  r = await s.get('/assets/app-abc123.js', { 'accept-encoding': 'br;q=0, gzip' });
  assert.equal(r.headers['content-encoding'], 'gzip');
  r = await s.get('/assets/app-abc123.js');
  assert.equal(r.headers['content-encoding'], undefined);
  assert.match(r.headers.vary, /Accept-Encoding/);
  assert.equal(r.body.toString(), big);
  r = await s.get('/', { 'accept-encoding': 'gzip' });
  assert.equal(r.headers['content-encoding'], 'gzip');
  s.close();
});

test('static: wasm type, skips tiny and already-compressed files', async () => {
  const s = await boot();
  let r = await s.get('/assets/solver-abc123.wasm', { 'accept-encoding': 'gzip' });
  assert.equal(r.headers['content-type'], 'application/wasm');
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(r.body), wasm);
  assert.equal((await s.get('/assets/app-abc123.js')).headers['content-type'], 'text/javascript');
  r = await s.get('/assets/pic.png', { 'accept-encoding': 'gzip, br' });
  assert.equal(r.headers['content-encoding'], undefined); assert.deepEqual(r.body, png);
  r = await s.get('/assets/tiny.js', { 'accept-encoding': 'gzip, br' });
  assert.equal(r.headers['content-encoding'], undefined); assert.equal(r.body.toString(), 'a=1');
  s.close();
});

test('static: cache-control, ETag/304, security headers', async () => {
  const s = await boot();
  let r = await s.get('/assets/app-abc123.js');
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
  r = await s.get('/index.html'); assert.equal(r.headers['cache-control'], 'no-cache');
  r = await s.get('/spa/route'); assert.equal(r.headers['cache-control'], 'no-cache');
  const ae = { 'accept-encoding': 'gzip' };
  r = await s.get('/', ae);
  const etag = r.headers.etag; assert.ok(etag);
  const r2 = await s.get('/', { ...ae, 'if-none-match': etag });
  assert.equal(r2.status, 304); assert.equal(r2.body.length, 0);
  assert.equal(r2.headers['cache-control'], 'no-cache');
  assert.match(r2.headers['content-security-policy'], /wasm-unsafe-eval/);
  assert.equal(r2.headers.etag, etag);
  // etag differs per encoding; identity etag must not match the gzip variant
  assert.equal((await s.get('/', { 'if-none-match': etag })).status, 200);
  assert.equal((await s.get('/', { ...ae, 'if-none-match': `W/${etag}, "other"` })).status, 304);
  assert.equal((await s.get('/', { 'if-modified-since': r.headers['last-modified'] })).status, 304);
  assert.equal((await s.get('/', { 'if-modified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' })).status, 200);
  assert.equal((await s.get('/assets/app-abc123.js', { ...ae, 'if-none-match': (await s.get('/assets/app-abc123.js', ae)).headers.etag })).status, 304);
  s.close();
});

test('static: HEAD parity, Range ignored, API stays no-store', async () => {
  const s = await boot();
  for (const p of ['/assets/app-abc123.js', '/', '/assets/pic.png']) {
    for (const ae of ['gzip', 'br', 'identity']) {
      const g = await s.get(p, { 'accept-encoding': ae });
      const h = await s.get(p, { 'accept-encoding': ae }, 'HEAD');
      assert.equal(h.status, g.status); assert.equal(h.body.length, 0);
      for (const k of ['content-type', 'content-length', 'content-encoding', 'etag', 'cache-control', 'vary', 'content-security-policy'])
        assert.equal(h.headers[k], g.headers[k], `${p} ${ae} ${k}`);
    }
  }
  const r = await s.get('/assets/app-abc123.js', { range: 'bytes=0-9' });
  assert.equal(r.status, 200); assert.equal(r.body.toString(), big); // Range ignored safely
  assert.equal((await s.get('/api/health')).headers['cache-control'], 'no-store');
  s.close();
});
