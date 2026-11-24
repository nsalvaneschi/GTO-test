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
  // Hand-history import (docs/handhistory-design.md): replaces the unused stub.
  `DROP TABLE hand_histories;
   CREATE TABLE hh_hands (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     site TEXT NOT NULL,
     hand_id TEXT NOT NULL,
     played_at INTEGER NOT NULL,
     imported_at INTEGER NOT NULL,
     players INTEGER NOT NULL,
     hero_pos TEXT,
     norm_json TEXT NOT NULL,
     raw_text TEXT,
     UNIQUE (user_id, site, hand_id)
   );
   CREATE INDEX hh_hands_user_time ON hh_hands(user_id, played_at);
   CREATE TABLE hh_decisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     hand_row INTEGER NOT NULL REFERENCES hh_hands(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     street TEXT NOT NULL,
     node_path TEXT NOT NULL,
     action_idx INTEGER NOT NULL,
     status TEXT NOT NULL,
     reason TEXT,
     solver_freqs TEXT,
     ev_loss REAL,
     range_preset TEXT NOT NULL,
     engine_ver TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX hh_decisions_user ON hh_decisions(user_id, status, street);
   CREATE INDEX hh_decisions_hand ON hh_decisions(hand_row);`,
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

// Migrations are forward-only and each runs in a transaction. BACK UP the volume's app.db (plus -wal/-shm,
// or `VACUUM INTO 'backup.db'`) before deploying a release that adds a migration.
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
