import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.ts';
import { db, logEvent, type Segment } from './db.ts';
import { Nextcloud } from './nextcloud.ts';

const DAY = 86_400_000;
let client: Nextcloud | undefined;
let uploading = false;

/** Call after Nextcloud settings change. */
export const resetNextcloud = (): void => void (client = undefined);

function nextcloud(): Nextcloud {
  return (client ??= new Nextcloud(getConfig().nextcloud));
}

/** <remoteDir>/ch01/2026-10-29/20261029_101000.mp4 */
function remotePathFor(seg: Segment): string {
  const d = new Date(seg.started_at);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return [getConfig().nextcloud.remoteDir, `ch${String(seg.channel).padStart(2, '0')}`, day, path.basename(seg.file)].join('/');
}

function deleteLocal(seg: Segment): void {
  fs.rmSync(seg.file, { force: true });
  db.prepare('UPDATE segments SET local_deleted = 1 WHERE id = ?').run(seg.id);
}

/** Upload pending segments one at a time, oldest first. */
export async function uploadPending(): Promise<void> {
  const cfg = getConfig();
  if (uploading || !cfg.nextcloud.enabled || !cfg.nextcloud.url) return;
  uploading = true;
  try {
    const pending = db
      .prepare(`SELECT * FROM segments WHERE remote_status IN ('pending','failed') AND local_deleted = 0
                ORDER BY started_at LIMIT 50`)
      .all() as unknown as Segment[];
    let missing = 0;
    for (const seg of pending) {
      if (!getConfig().nextcloud.enabled) break;
      // A file deleted or lost outside the app can never be uploaded; drop it instead of blocking the queue.
      if (!fs.existsSync(seg.file)) {
        db.prepare(`UPDATE segments SET local_deleted = 1, remote_status = 'failed', error = 'local file missing'
                    WHERE id = ?`).run(seg.id);
        missing++;
        continue;
      }
      const remote = remotePathFor(seg);
      try {
        await nextcloud().upload(seg.file, remote);
        db.prepare(`UPDATE segments SET remote_status = 'uploaded', remote_path = ?, uploaded_at = ?, error = NULL,
                    attempts = attempts + 1 WHERE id = ?`).run(remote, Date.now(), seg.id);
        if (getConfig().recording.deleteLocalAfterUpload) deleteLocal(seg);
      } catch (e) {
        const msg = (e as Error).message;
        db.prepare(`UPDATE segments SET remote_status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?`)
          .run(msg, seg.id);
        logEvent('error', `Nextcloud upload failed: ${msg}`);
        break; // likely a connectivity problem; try again next cycle
      }
    }
    if (missing) logEvent('warn', `Skipped ${missing} segment(s) whose local file no longer exists`);
  } finally {
    uploading = false;
  }
}

/** Apply local and Nextcloud TTLs. */
export async function enforceRetention(): Promise<void> {
  const cfg = getConfig();
  const now = Date.now();

  const localExpired = db
    .prepare('SELECT * FROM segments WHERE local_deleted = 0 AND started_at < ?')
    .all(now - cfg.recording.localTtlDays * DAY) as unknown as Segment[];
  const notBackedUp = localExpired.filter((s) => cfg.nextcloud.enabled && s.remote_status !== 'uploaded').length;
  localExpired.forEach(deleteLocal);
  if (localExpired.length) logEvent('info', `Local TTL: removed ${localExpired.length} segment(s)`);
  if (notBackedUp) logEvent('warn', `Local TTL removed ${notBackedUp} segment(s) that were never uploaded to Nextcloud`);

  if (!cfg.nextcloud.enabled || !cfg.nextcloud.url) return;
  const remoteExpired = db
    .prepare(`SELECT * FROM segments WHERE remote_status = 'uploaded' AND started_at < ?`)
    .all(now - cfg.nextcloud.ttlDays * DAY) as unknown as Segment[];
  let removed = 0;
  for (const seg of remoteExpired) {
    try {
      await nextcloud().delete(seg.remote_path!);
      db.prepare(`UPDATE segments SET remote_status = 'deleted' WHERE id = ?`).run(seg.id);
      removed++;
    } catch (e) {
      logEvent('error', `Nextcloud TTL delete failed: ${(e as Error).message}`);
      break;
    }
  }
  if (removed) logEvent('info', `Nextcloud TTL: removed ${removed} segment(s)`);
  // Fully forgotten rows (gone everywhere) are kept 90 days for the history view.
  db.prepare(`DELETE FROM segments WHERE local_deleted = 1 AND remote_status IN ('deleted','pending','failed')
              AND started_at < ?`).run(now - 90 * DAY);
}

export function startSyncLoops(): void {
  setInterval(() => void uploadPending(), 15_000);
  setInterval(() => void enforceRetention(), 3600_000);
  void enforceRetention();
}
