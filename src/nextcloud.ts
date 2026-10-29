import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { Config } from './config.ts';

/** Minimal WebDAV client for Nextcloud's files endpoint. */
export class Nextcloud {
  private base: string;
  private auth: string;
  private knownDirs = new Set<string>();

  constructor(cfg: Config['nextcloud']) {
    this.base = `${cfg.url.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(cfg.username)}`;
    this.auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  }

  private href(remotePath: string): string {
    const parts = remotePath.split('/').filter(Boolean).map(encodeURIComponent);
    return `${this.base}/${parts.join('/')}`;
  }

  private async req(method: string, remotePath: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(this.href(remotePath), {
        ...init,
        method,
        headers: { Authorization: this.auth, ...(init.headers as Record<string, string>) },
        signal: init.signal ?? AbortSignal.timeout(30 * 60_000),
      });
    } catch (e) {
      // undici hides the useful part (ECONNREFUSED, ENOTFOUND, cert errors…) in `cause`.
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`cannot reach Nextcloud: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
    }
  }

  async ensureDir(dir: string): Promise<void> {
    let acc = '';
    for (const part of dir.split('/').filter(Boolean)) {
      acc += '/' + part;
      if (this.knownDirs.has(acc)) continue;
      const res = await this.req('MKCOL', acc);
      // 201 created, 405 already exists
      if (res.status !== 201 && res.status !== 405) throw new Error(`MKCOL ${acc}: HTTP ${res.status}`);
      this.knownDirs.add(acc);
    }
  }

  async upload(localFile: string, remotePath: string): Promise<void> {
    await this.ensureDir(remotePath.split('/').slice(0, -1).join('/'));
    const { size } = fs.statSync(localFile);
    const res = await this.req('PUT', remotePath, {
      body: Readable.toWeb(fs.createReadStream(localFile)) as ReadableStream,
      headers: { 'Content-Length': String(size), 'Content-Type': 'video/mp4' },
      // @ts-expect-error -- required by undici for streamed request bodies
      duplex: 'half',
    });
    if (res.status !== 201 && res.status !== 204) throw new Error(`PUT: HTTP ${res.status}`);
  }

  async delete(remotePath: string): Promise<void> {
    const res = await this.req('DELETE', remotePath);
    if (res.status !== 204 && res.status !== 404) throw new Error(`DELETE: HTTP ${res.status}`);
  }

  /** Verifies credentials and that the target folder is writable. */
  async test(remoteDir: string): Promise<void> {
    const res = await this.req('PROPFIND', '/', { headers: { Depth: '0' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401) throw new Error('authentication failed (use an app password if 2FA is on)');
    if (res.status !== 207) throw new Error(`unexpected HTTP ${res.status} — check the URL`);
    await this.ensureDir(remoteDir);
  }
}
