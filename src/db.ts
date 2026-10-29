import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.ts';

export type RemoteStatus = 'pending' | 'uploaded' | 'failed' | 'deleted';

export interface Segment {
  id: number;
  channel: number;
  file: string; // absolute local path
  started_at: number; // ms epoch
  size: number;
  local_deleted: number;
  remote_status: RemoteStatus;
  remote_path: string | null;
  uploaded_at: number | null;
  attempts: number;
  error: string | null;
}

export const db = new DatabaseSync(path.join(DATA_DIR, 'camera_recorder.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY,
    channel INTEGER NOT NULL,
    file TEXT NOT NULL UNIQUE,
    started_at INTEGER NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    local_deleted INTEGER NOT NULL DEFAULT 0,
    remote_status TEXT NOT NULL DEFAULT 'pending',
    remote_path TEXT,
    uploaded_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS segments_remote ON segments(remote_status);
  CREATE INDEX IF NOT EXISTS segments_started ON segments(started_at);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
`);

let lastMessage = '';

/** Persistent log shown in the panel. Consecutive duplicates are dropped to avoid retry spam. */
export function logEvent(level: 'info' | 'warn' | 'error', message: string): void {
  console[level === 'info' ? 'log' : level](`[${level}] ${message}`);
  if (message === lastMessage) return;
  lastMessage = message;
  db.prepare('INSERT INTO events (ts, level, message) VALUES (?, ?, ?)').run(Date.now(), level, message);
  db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) - 2000 FROM events)').run();
}

export function addSegment(channel: number, file: string, startedAt: number, size: number): void {
  db.prepare('INSERT OR IGNORE INTO segments (channel, file, started_at, size) VALUES (?, ?, ?, ?)').run(
    channel, file, startedAt, size,
  );
}

export const segmentExists = (file: string): boolean =>
  db.prepare('SELECT 1 FROM segments WHERE file = ?').get(file) !== undefined;
