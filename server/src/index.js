import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, resolveDbPath } from './db.js';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const db = openDb(resolveDbPath());
const webDist = resolve(process.env.WEB_DIST ?? resolve(here, '../../web/dist'));
const port = Number(process.env.PORT ?? 3000);
// Railway terminates TLS and sets x-forwarded-*; trust it there or when TRUST_PROXY=1 (never by default).
const trustProxy = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : !!process.env.RAILWAY_ENVIRONMENT;
createApp({ db, webDist, trustProxy }).listen(port, '0.0.0.0', () => console.log(`listening on ${port}`));
