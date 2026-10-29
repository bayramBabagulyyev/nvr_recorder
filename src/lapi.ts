import crypto from 'node:crypto';
import type { Config } from './config.ts';

/** Uniview LAPI (the NVR's HTTP API). Uses HTTP Digest auth, which fetch doesn't do on its own. */

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const nonces = new Map<string, Record<string, string>>(); // apiUrl -> last digest challenge
let nc = 0;

const baseUrl = (nvr: Config['nvr']) => (nvr.apiUrl || `http://${nvr.host}`).replace(/\/+$/, '');

function digestHeader(nvr: Config['nvr'], ch: Record<string, string>, method: string, uri: string): string {
  const cnonce = crypto.randomBytes(8).toString('hex');
  const count = (++nc).toString(16).padStart(8, '0');
  const ha1 = md5(`${nvr.username}:${ch.realm}:${nvr.password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${ch.nonce}:${count}:${cnonce}:auth:${ha2}`);
  return `Digest username="${nvr.username}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", ` +
    `algorithm=MD5, qop=auth, nc=${count}, cnonce="${cnonce}", response="${response}"`;
}

const parseChallenge = (h: string): Record<string, string> =>
  Object.fromEntries([...h.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]));

async function lapiGet<T>(nvr: Config['nvr'], uri: string): Promise<T> {
  const base = baseUrl(nvr);
  for (let attempt = 0; attempt < 2; attempt++) {
    const challenge = nonces.get(base);
    const res = await fetch(base + uri, {
      headers: challenge ? { Authorization: digestHeader(nvr, challenge, 'GET', uri) } : {},
      signal: AbortSignal.timeout(30000),
    }).catch((e) => {
      const cause = (e as { cause?: { code?: string } }).cause;
      throw new Error(`cannot reach NVR API: ${cause?.code ?? (e as Error).message}`);
    });
    if (res.status === 401) {
      const auth = res.headers.get('www-authenticate') ?? '';
      if (!auth.startsWith('Digest') || (challenge && attempt > 0)) throw new Error('NVR API: authentication failed');
      nonces.set(base, parseChallenge(auth));
      continue;
    }
    const body = (await res.json().catch(() => null)) as { Response?: { ResponseCode: number; ResponseString: string; Data: T } } | null;
    if (!body?.Response) throw new Error(`NVR API: unexpected HTTP ${res.status}`);
    if (body.Response.ResponseCode !== 0) throw new Error(`NVR API: ${body.Response.ResponseString}`);
    return body.Response.Data;
  }
  throw new Error('NVR API: authentication failed');
}

export async function deviceInfo(nvr: Config['nvr']): Promise<{ model: string; firmware: string }> {
  const d = await lapiGet<{ DeviceModel: string; FirmwareVersion: string }>(nvr, '/LAPI/V1.0/System/DeviceInfo');
  return { model: d.DeviceModel, firmware: d.FirmwareVersion };
}

export interface RecordRange {
  begin: number; // ms epoch
  end: number;
  motion: boolean; // RecordType is a bitmask; 0x4 marks motion-triggered recording
}

/** Everything the NVR recorded for a channel in [from, to]. */
export async function records(nvr: Config['nvr'], channel: number, from: number, to: number): Promise<RecordRange[]> {
  const uri = `/LAPI/V1.0/Channels/${channel}/Media/Video/Streams/0/Records?Begin=${Math.floor(from / 1000)}&End=${Math.ceil(to / 1000)}`;
  const d = await lapiGet<{ RecordInfos?: { RecordType: number; Begin: number; End: number }[] }>(nvr, uri);
  return (d.RecordInfos ?? []).map((r) => ({ begin: r.Begin * 1000, end: r.End * 1000, motion: (r.RecordType & 4) !== 0 }));
}
