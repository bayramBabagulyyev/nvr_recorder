import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { getConfig, type Channel } from './config.ts';
import { addSegment, logEvent, segmentExists } from './db.ts';
import { redact, rtspUrl } from './nvr.ts';

export type RecorderState = 'stopped' | 'starting' | 'recording' | 'retrying';

export const channelDir = (id: number): string =>
  path.join(getConfig().recording.localDir, `ch${String(id).padStart(2, '0')}`);

/** Segment files are named by ffmpeg strftime: YYYYMMDD_HHMMSS.mp4 (local time). */
function parseStart(file: string): number {
  const m = path.basename(file).match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/);
  if (!m) return fs.statSync(file).mtimeMs;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function registerSegment(channel: number, file: string): void {
  if (!fs.existsSync(file)) return;
  const { size } = fs.statSync(file);
  if (size === 0) return void fs.unlinkSync(file);
  addSegment(channel, file, parseStart(file), size);
}

class ChannelRecorder {
  state: RecorderState = 'stopped';
  lastError = '';
  since = 0;
  lastSegmentAt = 0;
  private proc?: ChildProcess;
  private stopping = false;
  private retryTimer?: NodeJS.Timeout;
  private backoff = 5000;
  private stderrTail: string[] = [];

  readonly channel: Channel;

  constructor(channel: Channel) {
    this.channel = channel;
  }

  start(): void {
    this.stopping = false;
    const cfg = getConfig();
    const dir = channelDir(this.channel.id);
    fs.mkdirSync(dir, { recursive: true });

    const args = [
      '-hide_banner', '-loglevel', 'warning', '-nostdin',
      '-rtsp_transport', 'tcp', '-timeout', '10000000',
      '-i', rtspUrl(cfg.nvr, this.channel),
      // Video is copied untouched; G.711 audio from UNV can't go in MP4, so it's converted to AAC.
      '-map', '0:v', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k',
      '-f', 'segment', '-segment_time', String(cfg.recording.segmentMinutes * 60),
      '-segment_atclocktime', '1', '-reset_timestamps', '1', '-strftime', '1',
      '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart',
      '-segment_list', 'pipe:1', '-segment_list_type', 'flat',
      path.join(dir, '%Y%m%d_%H%M%S.mp4'),
    ];

    this.state = 'starting';
    this.since = Date.now();
    this.stderrTail = [];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    // ffmpeg prints each finished segment's filename to stdout.
    readline.createInterface({ input: proc.stdout! }).on('line', (name) => {
      registerSegment(this.channel.id, path.join(dir, name.trim()));
      this.lastSegmentAt = Date.now();
      this.backoff = 5000;
    });
    readline.createInterface({ input: proc.stderr! }).on('line', (line) => {
      this.stderrTail = [...this.stderrTail.slice(-9), redact(line)];
    });
    // ffmpeg is quiet at warning level once it's running; treat a few seconds alive as "recording".
    const upTimer = setTimeout(() => this.proc === proc && (this.state = 'recording'), 8000);

    proc.on('error', (e) => (this.lastError = e.message));
    proc.on('exit', (code) => {
      clearTimeout(upTimer);
      if (this.proc !== proc) return;
      this.proc = undefined;
      if (this.stopping) {
        this.state = 'stopped';
        return;
      }
      this.lastError = this.stderrTail.at(-1) ?? `ffmpeg exited with code ${code}`;
      logEvent('warn', `${this.channel.name}: recorder stopped (${this.lastError}); retrying in ${this.backoff / 1000}s`);
      this.state = 'retrying';
      this.retryTimer = setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 120_000);
    });
  }

  /** SIGINT lets ffmpeg finalize (and report) the segment in progress. */
  stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    const proc = this.proc;
    if (!proc) {
      this.state = 'stopped';
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const kill = setTimeout(() => proc.kill('SIGKILL'), 15000);
      proc.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      proc.kill('SIGINT');
    });
  }
}

class RecorderManager {
  private recorders: ChannelRecorder[] = [];

  /** Register files left behind by a crash/power loss so they still get uploaded. */
  recoverOrphans(): void {
    for (const ch of getConfig().nvr.channels) {
      const dir = channelDir(ch.id);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (name.endsWith('.mp4') && !segmentExists(file)) registerSegment(ch.id, file);
      }
    }
  }

  async apply(): Promise<void> {
    await Promise.all(this.recorders.map((r) => r.stop()));
    this.recorders = [];
    const cfg = getConfig();
    if (!cfg.recording.enabled || !cfg.nvr.host) return;
    this.recoverOrphans();
    for (const ch of cfg.nvr.channels.filter((c) => c.enabled)) {
      const r = new ChannelRecorder(ch);
      r.start();
      this.recorders.push(r);
    }
    logEvent('info', `Recording started for ${this.recorders.length} channel(s)`);
  }

  stopAll = () => Promise.all(this.recorders.map((r) => r.stop()));

  status() {
    return this.recorders.map((r) => ({
      id: r.channel.id,
      name: r.channel.name,
      state: r.state,
      since: r.since,
      lastSegmentAt: r.lastSegmentAt,
      lastError: r.lastError,
    }));
  }
}

export const recorders = new RecorderManager();
