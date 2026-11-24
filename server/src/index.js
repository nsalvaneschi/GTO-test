import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, resolveDbPath } from './db.js';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const db = openDb(resolveDbPath());
const webDist = resolve(process.env.WEB_DIST ?? resolve(here, '../../web/dist'));
const port = Number(process.env.PORT ?? 3000);
createApp({ db, webDist }).listen(port, '0.0.0.0', () => console.log(`listening on ${port}`));
