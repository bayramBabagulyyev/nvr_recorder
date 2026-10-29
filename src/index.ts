import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { getConfig, loadConfig, maskedConfig, saveConfig, SECRET_MASK, type Config } from './config.ts';
import { db, logEvent } from './db.ts';
import { Nextcloud } from './nextcloud.ts';
import { detectChannels, probe, rtspUrl } from './nvr.ts';
import { recorders } from './recorder.ts';
import { resetNextcloud, startSyncLoops, uploadPending } from './sync.ts';

const PORT = Number(process.env.PORT ?? 8080);
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Copy .env.example to .env and set a password for the web panel.');
  process.exit(1);
}

loadConfig();
const app = Fastify({ logger: false });
const expectedAuth = Buffer.from('Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64'));

// The panel holds NVR and Nextcloud credentials, so everything sits behind HTTP Basic auth.
app.addHook('onRequest', async (req, reply) => {
  const got = Buffer.from(req.headers.authorization ?? '');
  if (got.length !== expectedAuth.length || !crypto.timingSafeEqual(got, expectedAuth)) {
    return reply.header('WWW-Authenticate', 'Basic realm="camera_recorder"').code(401).send('Unauthorized');
  }
});

const indexHtml = path.join(import.meta.dirname, '..', 'public', 'index.html');
app.get('/', (_req, reply) => reply.type('text/html').send(fs.createReadStream(indexHtml)));

app.get('/api/config', () => maskedConfig());

app.put<{ Body: Config }>('/api/config', async (req) => {
  const before = JSON.stringify({ ...getConfig(), nextcloud: undefined });
  const next = req.body;
  next.recording.segmentMinutes = Math.max(1, Math.min(60, Number(next.recording.segmentMinutes) || 10));
  saveConfig(next);
  resetNextcloud();
  // Only restart ffmpeg when something recording-related changed.
  if (JSON.stringify({ ...getConfig(), nextcloud: undefined }) !== before) await recorders.apply();
  logEvent('info', 'Configuration saved');
  return maskedConfig();
});

type NvrBody = { nvr: Config['nvr'] };
const withSavedPassword = (nvr: Config['nvr']) =>
  nvr.password === SECRET_MASK ? { ...nvr, password: getConfig().nvr.password } : nvr;

app.post<{ Body: NvrBody & { channel?: number } }>('/api/nvr/test', async (req) =>
  probe(rtspUrl(withSavedPassword(req.body.nvr), { id: req.body.channel ?? 1, stream: 'sub' })),
);

app.post<{ Body: NvrBody & { max?: number } }>('/api/nvr/detect', async (req) =>
  detectChannels(withSavedPassword(req.body.nvr), Math.min(req.body.max ?? 32, 64)),
);

app.post<{ Body: { nextcloud: Config['nextcloud'] } }>('/api/nextcloud/test', async (req) => {
  const nc = req.body.nextcloud;
  if (nc.password === SECRET_MASK) nc.password = getConfig().nextcloud.password;
  try {
    await new Nextcloud(nc).test(nc.remoteDir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

app.post<{ Params: { action: 'start' | 'stop' } }>('/api/recording/:action', async (req) => {
  const cfg = getConfig();
  saveConfig({ ...cfg, recording: { ...cfg.recording, enabled: req.params.action === 'start' } });
  await recorders.apply();
  if (req.params.action === 'stop') logEvent('info', 'Recording stopped');
  return { ok: true };
});

app.post('/api/sync', async () => {
  void uploadPending();
  return { ok: true };
});

app.get('/api/status', () => {
  const totals = db
    .prepare(`SELECT
        COUNT(*) AS segments,
        COALESCE(SUM(CASE WHEN local_deleted = 0 THEN size END), 0) AS localBytes,
        COALESCE(SUM(CASE WHEN remote_status = 'uploaded' THEN size END), 0) AS remoteBytes,
        SUM(remote_status IN ('pending','failed') AND local_deleted = 0) AS queued,
        MAX(uploaded_at) AS lastUpload
      FROM segments`)
    .get();
  return { recording: getConfig().recording.enabled, channels: recorders.status(), totals };
});

app.get<{ Querystring: { channel?: string; page?: string } }>('/api/history', (req) => {
  const page = Math.max(0, Number(req.query.page ?? 0));
  const channel = req.query.channel ? Number(req.query.channel) : null;
  const rows = db
    .prepare(`SELECT id, channel, file, started_at, size, local_deleted, remote_status, remote_path, uploaded_at, error
              FROM segments WHERE (? IS NULL OR channel = ?) ORDER BY started_at DESC LIMIT 100 OFFSET ?`)
    .all(channel, channel, page * 100);
  return { rows, page };
});

app.get('/api/events', () => db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all());

const shutdown = async () => {
  await recorders.stopAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: '0.0.0.0' });
logEvent('info', `camera_recorder panel listening on :${PORT}`);
await recorders.apply();
startSyncLoops();
