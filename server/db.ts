import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  hue INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  next_seq INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lead_id INTEGER REFERENCES actors(id),
  UNIQUE(product_id, name)
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  component_id INTEGER NOT NULL REFERENCES components(id),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unconfirmed',
  resolution TEXT,
  severity TEXT NOT NULL DEFAULT 'normal',
  priority TEXT NOT NULL DEFAULT 'p3',
  reporter_id INTEGER NOT NULL REFERENCES actors(id),
  assignee_id INTEGER REFERENCES actors(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_product ON issues(product_id);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_id);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY (issue_id, label)
);

CREATE TABLE IF NOT EXISTS watchers (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES actors(id),
  PRIMARY KEY (issue_id, actor_id)
);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY,
  src_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  dst_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(src_id, dst_id, kind)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES actors(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES actors(id),
  kind TEXT NOT NULL,
  field TEXT,
  from_value TEXT,
  to_value TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_id);

CREATE VIRTUAL TABLE IF NOT EXISTS issue_fts USING fts5(
  key, title, body, labels
);
`;

export type DB = DatabaseSync;

export function openDb(file?: string): DB {
  const dbFile = file ?? process.env.QUARRY_DB ?? path.join(process.cwd(), 'data', 'quarry.db');
  if (dbFile !== ':memory:') {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  }
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside a transaction; roll back on any throw. */
export function withTransaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Rebuild the FTS index row for one issue. */
export function reindexIssue(db: DB, issueId: number): void {
  const row = db
    .prepare(
      `SELECT i.id, i.key, i.title, i.body,
              COALESCE((SELECT group_concat(label, ' ') FROM issue_labels WHERE issue_id = i.id), '') AS labels
       FROM issues i WHERE i.id = ?`,
    )
    .get(issueId) as { id: number; key: string; title: string; body: string; labels: string } | undefined;
  if (!row) return;
  db.prepare(`DELETE FROM issue_fts WHERE rowid = ?`).run(row.id);
  db.prepare(`INSERT INTO issue_fts(rowid, key, title, body, labels) VALUES (?, ?, ?, ?, ?)`).run(
    row.id,
    row.key,
    row.title,
    row.body,
    row.labels,
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}
