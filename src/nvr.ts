import { spawn } from 'node:child_process';
import type { Channel, Config } from './config.ts';

/**
 * Uniview (UNV) NVR RTSP layout: /unicast/c<channel>/s<stream>/live
 * where stream 0 = main, 1 = sub.
 */
export function rtspUrl(nvr: Config['nvr'], ch: Pick<Channel, 'id' | 'stream' | 'url'>): string {
  if (ch.url) return ch.url;
  const auth = `${encodeURIComponent(nvr.username)}:${encodeURIComponent(nvr.password)}@`;
  return `rtsp://${auth}${nvr.host}:${nvr.rtspPort}/unicast/c${ch.id}/s${ch.stream === 'sub' ? 1 : 0}/live`;
}

/** Strip credentials from anything that may contain an RTSP URL. */
export const redact = (s: string): string => s.replace(/(rtsp:\/\/)[^@/\s]+@/g, '$1***@');

export interface ProbeResult {
  ok: boolean;
  video?: string; // e.g. "h265 2560x1440"
  audio?: string;
  error?: string;
}

export function probe(url: string, timeoutMs = 12000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-rtsp_transport', 'tcp', '-timeout', '6000000',
      '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', url,
    ]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: redact(err.trim().split('\n').pop() || 'timeout') });
      const streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] =
        JSON.parse(out).streams ?? [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      resolve({
        ok: !!v,
        video: v && `${v.codec_name} ${v.width}x${v.height}`,
        audio: a?.codec_name,
        error: v ? undefined : 'no video stream',
      });
    });
  });
}

/** Probe channels 1..max on the NVR and return the ones that deliver video. */
export async function detectChannels(nvr: Config['nvr'], max = 32): Promise<(ProbeResult & { id: number })[]> {
  const ids = Array.from({ length: max }, (_, i) => i + 1);
  const found: (ProbeResult & { id: number })[] = [];
  const worker = async () => {
    for (let id = ids.shift(); id !== undefined; id = ids.shift()) {
      const r = await probe(rtspUrl(nvr, { id, stream: 'sub' }), 8000);
      if (r.ok) found.push({ id, ...r });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return found.sort((a, b) => a.id - b.id);
}
