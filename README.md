# camera_recorder

A second, independent copy of your Uniview (UNV) NVR recordings. If the NVR is stolen, broken or wiped,
the footage still exists on this server and/or in your Nextcloud.

```
UNV NVR ──RTSP──▶ camera_recorder ──▶ local disk (TTL)
 (or cameras)        (ffmpeg copy)  └─▶ Nextcloud via WebDAV (TTL)
```

- Pulls each NVR channel over RTSP (`/unicast/c<N>/s0/live`). Video is **stream-copied** (no re-encoding,
  so CPU use is low and quality is the same). UNV G.711 audio is converted to AAC so it fits in MP4.
- Writes clock-aligned MP4 segments (default 10 min): `recordings/ch01/20261029_101000.mp4`
- Uploads finished segments to Nextcloud: `<remoteDir>/ch01/2026-10-29/20261029_101000.mp4`.
  If Nextcloud is down, segments wait in a queue and upload when it comes back.
- Separate TTLs for local disk and Nextcloud. Optionally deletes the local copy after upload.
- Restarts ffmpeg automatically (with backoff) if the NVR or network drops.
- Web panel: NVR settings, channel auto-detect, connection tests, storage/TTL, backup history, event log.

## Run

Requires Node.js ≥ 24 and ffmpeg. Docker is the easiest option:

```bash
cp .env.example .env        # set ADMIN_PASSWORD
docker compose up -d --build
```

Without Docker:

```bash
sudo apt install ffmpeg
npm install
cp .env.example .env        # set ADMIN_PASSWORD
npm start
```

Open `http://<server>:8080` and log in with `ADMIN_USER` / `ADMIN_PASSWORD`.

1. **NVR** tab: enter the NVR IP, RTSP port (554), username and password → **Test connection** →
   **Detect channels** → choose which channels to record and main or sub stream → **Save**.
2. **Storage** tab: set segment length and local TTL. Enable Nextcloud, enter the URL, username and an
   **app password** (Nextcloud → Settings → Security → *Create new app password*) → **Test Nextcloud** → **Save**.
3. **Status** tab: **Start recording**.

## Notes

- **Keep this server away from the NVR.** Put it in a different room or building, or on a VPS behind a VPN.
  Otherwise a thief takes both.
- **Recording through the NVR stops once the NVR is gone.** Footage recorded up to that moment is safe.
  To keep recording without the NVR, set a channel's *Custom RTSP URL* to the camera itself, for example
  `rtsp://user:pass@192.168.1.64:554/media/video1` (UNV IPC main stream).
- **Bandwidth:** a 4 MP H.265 main stream is about 2–4 Mbit/s, roughly 20–40 GB per camera per day.
  If your upload link is slower than the total bitrate, use the *sub* stream or fewer channels.
- **Security:** `data/config.json` holds the NVR and Nextcloud passwords (file mode 600). Use a dedicated
  read-only NVR user, and don't expose the panel to the internet without HTTPS (use a reverse proxy).
- Remote TTL deletes only files that this app uploaded and still has in its database.

## Can the NVR do this by itself?

Partly. Check your model's web UI before you deploy this app.

- **Nextcloud directly: no.** Nextcloud only speaks WebDAV/HTTPS. UNV NVRs can't record to WebDAV.
- **NAS (NFS/SMB):** many UNV NVRs can add a network disk (*Storage → Hard Disk → Add NAS*). But on most
  models it's used *instead of* or *alongside* local disks as another storage location, not as a live
  mirror of the same footage. Some models offer **Disk Group / Redundancy**, which writes chosen channels
  to two disks. If your model can mirror to a NAS, you can sync that NAS to Nextcloud and skip this app.
- **FTP / Cloud upload:** it sends event snapshots and short alarm clips, not continuous recording.

If your NVR can't mirror continuously to an off-site location, use this app.
# nvr_recorder
