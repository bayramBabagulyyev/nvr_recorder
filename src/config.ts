import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** Placeholder sent to the panel instead of real secrets. */
export const SECRET_MASK = '********';

export interface Channel {
  id: number; // NVR channel number (1-based)
  name: string;
  enabled: boolean;
  stream: 'main' | 'sub';
  /** Optional full RTSP URL, e.g. straight to the camera instead of via the NVR. */
  url?: string;
}

export interface Config {
  nvr: {
    host: string;
    rtspPort: number;
    username: string;
    password: string;
    /** Base URL of the NVR web/LAPI interface; defaults to http://<host>. */
    apiUrl: string;
    channels: Channel[];
  };
  recording: {
    enabled: boolean;
    /** continuous: keep everything. motion: keep only segments overlapping NVR motion events. */
    mode: 'continuous' | 'motion';
    motionPreSeconds: number;
    motionPostSeconds: number;
    segmentMinutes: number;
    localDir: string;
    localTtlDays: number;
    deleteLocalAfterUpload: boolean;
  };
  nextcloud: {
    enabled: boolean;
    url: string; // e.g. https://cloud.example.com
    username: string;
    password: string; // app password recommended
    remoteDir: string;
    ttlDays: number;
  };
}

const defaults = (): Config => ({
  nvr: { host: '', rtspPort: 554, username: 'admin', password: '', apiUrl: '', channels: [] },
  recording: {
    enabled: false,
    mode: 'continuous',
    motionPreSeconds: 5,
    motionPostSeconds: 30,
    segmentMinutes: 10,
    localDir: path.join(DATA_DIR, 'recordings'),
    localTtlDays: 7,
    deleteLocalAfterUpload: false,
  },
  nextcloud: { enabled: false, url: '', username: '', password: '', remoteDir: 'camera_recorder', ttlDays: 30 },
});

let current: Config;

export function loadConfig(): Config {
  const base = defaults();
  if (fs.existsSync(CONFIG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    current = {
      nvr: { ...base.nvr, ...saved.nvr },
      recording: { ...base.recording, ...saved.recording },
      nextcloud: { ...base.nextcloud, ...saved.nextcloud },
    };
  } else {
    current = base;
  }
  return current;
}

export const getConfig = (): Config => current;

export function saveConfig(next: Config): Config {
  // Masked secrets mean "unchanged".
  if (next.nvr.password === SECRET_MASK) next.nvr.password = current.nvr.password;
  if (next.nextcloud.password === SECRET_MASK) next.nextcloud.password = current.nextcloud.password;
  current = next;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
  return current;
}

export function maskedConfig(): Config {
  const c = structuredClone(current);
  if (c.nvr.password) c.nvr.password = SECRET_MASK;
  if (c.nextcloud.password) c.nextcloud.password = SECRET_MASK;
  return c;
}
