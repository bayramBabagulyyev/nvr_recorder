import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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

// Tiny router on node:http — no npm dependencies, so the Docker build needs nothing but Docker Hub.
interface Req {
  body: any;
  query: URLSearchParams;
  params: Record<string, string>;
}
type Handler = (req: Req) => unknown;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
const route = (method: string) => (pathSpec: string, handler: Handler) => {
  const keys: string[] = [];
  const pattern = new RegExp('^' + pathSpec.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern, keys, handler });
};
const app = { get: route('GET'), post: route('POST'), put: route('PUT') };

const expectedAuth = Buffer.from('Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64'));
const indexHtml = path.join(import.meta.dirname, '..', 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  // The panel holds NVR and Nextcloud credentials, so everything sits behind HTTP Basic auth.
  const got = Buffer.from(req.headers.authorization ?? '');
  if (got.length !== expectedAuth.length || !crypto.timingSafeEqual(got, expectedAuth)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="camera_recorder"' }).end('Unauthorized');
    return;
  }
  // CSRF: browsers resend Basic credentials automatically, so writes must carry a custom header.
  // Other sites can't add one without a CORS preflight, which this server never approves.
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'camera_recorder') {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(indexHtml).pipe(res);
    return;
  }
  for (const r of routes) {
    const m = req.method === r.method && url.pathname.match(r.pattern);
    if (!m) continue;
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const result = await r.handler({ body: raw ? JSON.parse(raw) : {}, query: url.searchParams, params });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
    }
    return;
  }
  res.writeHead(404).end('Not found');
});

app.get('/api/config', () => maskedConfig());

app.put('/api/config', async (req) => {
  const before = JSON.stringify({ ...getConfig(), nextcloud: undefined });
  const next = req.body as Config;
  next.recording.segmentMinutes = Math.max(1, Math.min(60, Number(next.recording.segmentMinutes) || 10));
  saveConfig(next);
  resetNextcloud();
  // Only restart ffmpeg when something recording-related changed.
  if (JSON.stringify({ ...getConfig(), nextcloud: undefined }) !== before) await recorders.apply();
  logEvent('info', 'Configuration saved');
  return maskedConfig();
});

const withSavedPassword = (nvr: Config['nvr']) =>
  nvr.password === SECRET_MASK ? { ...nvr, password: getConfig().nvr.password } : nvr;

app.post('/api/nvr/test', async (req) =>
  probe(rtspUrl(withSavedPassword(req.body.nvr), { id: req.body.channel ?? 1, stream: 'sub' })),
);

app.post('/api/nvr/detect', async (req) =>
  detectChannels(withSavedPassword(req.body.nvr), Math.min(req.body.max ?? 32, 64)),
);

app.post('/api/nextcloud/test', async (req) => {
  const nc: Config['nextcloud'] = req.body.nextcloud;
  if (nc.password === SECRET_MASK) nc.password = getConfig().nextcloud.password;
  try {
    await new Nextcloud(nc).test(nc.remoteDir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

app.post('/api/recording/:action', async (req) => {
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

app.get('/api/history', (req) => {
  const page = Math.max(0, Number(req.query.get('page') ?? 0));
  const channel = req.query.get('channel') ? Number(req.query.get('channel')) : null;
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

await new Promise<void>((resolve) => server.listen(PORT, '0.0.0.0', resolve));
logEvent('info', `camera_recorder panel listening on :${PORT}`);
await recorders.apply();
startSyncLoops();
