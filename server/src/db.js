import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function resolveDbPath(env = process.env) {
  if (env.DB_PATH) return env.DB_PATH;
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return `${env.RAILWAY_VOLUME_MOUNT_PATH}/app.db`;
  return './data/app.db';
}

const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL,
     username_lc TEXT NOT NULL UNIQUE,
     pw_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE drill_results (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     spot_id TEXT NOT NULL,
     spot_type TEXT NOT NULL,
     hero INTEGER NOT NULL,
     hand_combo TEXT NOT NULL,
     action INTEGER NOT NULL,
     solver_freqs TEXT NOT NULL,
     ev_loss REAL NOT NULL,
     ms INTEGER NOT NULL,
     lang TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX drill_results_user_time ON drill_results(user_id, created_at);`,
  // Reserved, no feature yet.
  `CREATE TABLE hand_histories (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     raw_text TEXT NOT NULL,
     imported_at INTEGER NOT NULL
   );`,
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
