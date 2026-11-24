import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { openDb, resolveDbPath } from './db.js';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolveDbPath();
const db = openDb(dbPath);
const webDist = resolve(process.env.WEB_DIST ?? resolve(here, '../../web/dist'));
const port = Number(process.env.PORT ?? 3000);
// Railway terminates TLS and sets x-forwarded-*; trust it there or when TRUST_PROXY=1 (never by default).
const trustProxy = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : !!process.env.RAILWAY_ENVIRONMENT;
const version = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')).version;
const server = createApp({ db, webDist, trustProxy });
server.listen(port, '0.0.0.0', () => console.log(`gto-server v${version} listening on ${port} db=${dbPath}`));

// Railway sends SIGTERM on deploy: stop accepting, finish in-flight requests, close the DB.
let stopping = false;
function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`${sig} received, shutting down`);
  const force = setTimeout(() => { console.error('forced exit'); process.exit(1); }, 10000);
  force.unref();
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
