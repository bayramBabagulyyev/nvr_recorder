import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.ts';
import { db, logEvent, type Segment } from './db.ts';
import { records } from './lapi.ts';
import { Nextcloud } from './nextcloud.ts';

const DAY = 86_400_000;
let client: Nextcloud | undefined;
let uploading = false;
let checkingMotion = false;
/** If the NVR API can't answer for this long (offline, stolen…), keep segments instead of waiting. */
const NVR_GRACE = 10 * 60_000;

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

const segmentEnd = (seg: Segment): number =>
  seg.ended_at ?? seg.started_at + getConfig().recording.segmentMinutes * 60_000;

/**
 * Motion mode: decide for each finished segment whether to keep it, based on the NVR's own
 * motion-detection records. A segment is dropped only when the NVR has a recording for that
 * time and none of it is motion; anything the NVR can't vouch for is kept.
 */
export async function checkMotion(): Promise<void> {
  const cfg = getConfig();
  if (checkingMotion || cfg.recording.mode !== 'motion' || !cfg.nvr.host) return;
  checkingMotion = true;
  try {
    const pre = cfg.recording.motionPreSeconds * 1000;
    const post = cfg.recording.motionPostSeconds * 1000;
    const now = Date.now();
    // Wait until the post-motion window has passed so the NVR knows whether motion continued.
    const ready = (db
      .prepare(`SELECT * FROM segments WHERE motion IS NULL AND local_deleted = 0 AND remote_status IN ('pending','failed')
                ORDER BY started_at LIMIT 1000`)
      .all() as unknown as Segment[]).filter((s) => segmentEnd(s) < now - post - 60_000);

    const byChannel = Map.groupBy(ready, (s) => s.channel);
    let kept = 0;
    let dropped = 0;
    for (const [channel, segs] of byChannel) {
      const from = Math.min(...segs.map((s) => s.started_at)) - post;
      const to = Math.max(...segs.map(segmentEnd)) + pre;
      let ranges;
      try {
        ranges = await records(cfg.nvr, channel, from, to);
      } catch (e) {
        const stale = segs.filter((s) => segmentEnd(s) < now - NVR_GRACE);
        for (const s of stale) {
          db.prepare(`UPDATE segments SET motion = 1, error = 'NVR API unreachable, kept' WHERE id = ?`).run(s.id);
        }
        logEvent('warn', `Motion check failed (${(e as Error).message}); keeping segments older than 10 min`);
        kept += stale.length;
        continue;
      }
      for (const s of segs) {
        const [start, end] = [s.started_at, segmentEnd(s)];
        const covered = ranges.some((r) => r.begin < end && r.end > start);
        const motion = ranges.some((r) => r.motion && r.begin - pre < end && r.end + post > start);
        if (motion || !covered) {
          db.prepare(`UPDATE segments SET motion = 1, error = ? WHERE id = ?`)
            .run(motion ? null : 'NVR has no recording for this time, kept', s.id);
          kept++;
        } else {
          db.prepare(`UPDATE segments SET motion = 0, remote_status = 'skipped', error = 'no motion' WHERE id = ?`).run(s.id);
          deleteLocal(s);
          dropped++;
        }
      }
    }
    if (kept || dropped) logEvent('info', `Motion filter: kept ${kept}, dropped ${dropped} segment(s) without motion`);
  } finally {
    checkingMotion = false;
  }
}

/** Upload pending segments one at a time, oldest first. */
export async function uploadPending(): Promise<void> {
  const cfg = getConfig();
  if (uploading || !cfg.nextcloud.enabled || !cfg.nextcloud.url) return;
  uploading = true;
  try {
    const pending = db
      .prepare(`SELECT * FROM segments WHERE remote_status IN ('pending','failed') AND local_deleted = 0
                AND (? = 'continuous' OR motion = 1) ORDER BY started_at LIMIT 50`)
      .all(cfg.recording.mode) as unknown as Segment[];
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
  db.prepare(`DELETE FROM segments WHERE local_deleted = 1 AND remote_status IN ('deleted','pending','failed','skipped')
              AND started_at < ?`).run(now - 90 * DAY);
}

export function startSyncLoops(): void {
  setInterval(() => void checkMotion().then(uploadPending), 15_000);
  setInterval(() => void enforceRetention(), 3600_000);
  void enforceRetention();
}
