# stealth-chrome

Real Google Chrome in a container, driven over the Chrome DevTools Protocol
(CDP). Two images, one codebase, everything managed in TypeScript — no
supervisord, no bash entrypoints, no Python.

- **slim** (`latest`) — Chrome headless + CDP and nothing else. No X server,
  no audio stack, no VNC, no recording code. This is the image for agents /
  Puppeteer / Playwright / `agent-browser` style automation.
- **record** (`record`) — slim plus a headed display stack: Xvfb + fluxbox,
  PulseAudio, VNC/noVNC, and a recording web UI (start/stop captures,
  list + download recordings, live audio stream). Use this when you want to
  *watch* the browser or record it.

Both images are built and pushed to GHCR on **every push** by
[`.github/workflows/build.yml`](.github/workflows/build.yml).

## Quick start (pull and run)

```bash
# Slim (default):
docker compose up -d
curl http://127.0.0.1:9223/json/version

# Record variant:
docker compose --profile record up -d chrome-record
#   recording UI:  http://127.0.0.1:8080
#   noVNC:         http://127.0.0.1:6080
```

Or without compose:

```bash
docker run -d --name stealth-chrome --shm-size=2gb \
  -p 127.0.0.1:9223:9223 -v "$PWD/profile:/data" \
  ghcr.io/kk-spartans/stealth-chrome:latest

docker run -d --name stealth-chrome-record --shm-size=2gb \
  -p 127.0.0.1:9223:9223 -p 127.0.0.1:8080:8080 \
  -p 127.0.0.1:6080:6080 -p 127.0.0.1:5900:5900 \
  -v "$PWD/profile:/data" \
  ghcr.io/kk-spartans/stealth-chrome:record
```

> ⚠️ **CDP is unauthenticated.** Anyone who can reach the CDP port controls
> the browser (and everything logged into it). The compose file binds ports
> to `127.0.0.1` for this reason — don't publish them on a public interface
> without a proxy/auth in front. Same for the VNC port (no password).

## Images

| Image | GHCR ref | What's in it |
|-------|----------|--------------|
| slim | `ghcr.io/kk-spartans/stealth-chrome:latest` | Node 22 + Chrome + the TypeScript supervisor. Headless Chrome exposing CDP. ~350 MB. |
| record | `ghcr.io/kk-spartans/stealth-chrome:record` | Slim + Xvfb, fluxbox, PulseAudio, ffmpeg, x11vnc, noVNC, and the recording server. Headed Chrome at 1920×1080. |

Every push also publishes immutable copies tagged `sha-<commit>` (slim) and
`record-sha-<commit>` (record).

Why real branded Google Chrome and not Chromium? Google sign-in refuses
unbranded Chromium builds ("browser not secure"). A persistent profile with
real Chrome logs in fine with zero stealth patches. Note the slim image runs
Chrome **headless** (`--headless=new`), which is what CDP automation wants;
the record image runs it **headed** under Xvfb so you can see/record it.

## Ports

### Slim image — one port

| Port | What it is | Notes |
|------|------------|-------|
| **9223** | Chrome DevTools Protocol (CDP) — external | The port to publish/use. `GET /json/version`, `/json/list`, and the `webSocketDebuggerUrl` endpoints. An HTTP-aware TypeScript proxy inside the container forwards 9223 → Chrome's own loopback port, rewriting `Host` to loopback on every request (Chrome rejects non-local hosts with 500) and the debugger URL in `/json/*` responses back to the caller's host — so CDP works through a hostname/gateway, not just `127.0.0.1`. |
| 9222 | Chrome's DevTools, container-loopback only | Chrome binds DevTools to `127.0.0.1` only (it ignores `--remote-debugging-address=0.0.0.0` in current versions), so publishing 9222 directly does nothing — that's exactly why the 9223 proxy exists. Don't publish 9222. |

So from the host (with the compose mapping above):

```bash
curl http://127.0.0.1:9223/json/version   # browser + websocket URL
curl http://127.0.0.1:9223/json/list      # open targets
```

Point Puppeteer/Playwright/agent-browser at `http://127.0.0.1:9223` (or the
returned `webSocketDebuggerUrl`).

### Record image — CDP plus four more

| Port | What it is | Notes |
|------|------------|-------|
| **9223** | CDP (as above) | Same proxy, same behaviour. |
| **8080** | Recording web UI + API | Start/stop recordings, list + download `.mkv` files, live audio stream. See [Recording UI](#recording-ui-record-image-only) below. |
| **6080** | noVNC web UI | Browser-based VNC client for the headed desktop. Open in a browser, no password. |
| **5900** | VNC (RFB) | Raw VNC for a native VNC client. No password (`-nopw`). |
| 9222 | Chrome DevTools, loopback only | As above — internal only. |
| 4713 | PulseAudio TCP native protocol | Container-loopback only (`127.0.0.1:4713`, auth-anonymous). Chrome and ffmpeg talk to it inside the container; never publish it. |

## Recording UI (record image only)

A small Node HTTP server on **:8080** (TypeScript, `src/rec/`). Open
`http://127.0.0.1:8080` for the UI, or use the API directly:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | HTML UI: start/stop recording, list + download recordings, live audio player |
| GET | `/api/status` | JSON: `{"recording": bool, "path": ..., "started_at": ...}` |
| POST | `/api/recordings/start` | Start a capture (409 if one is already running) |
| POST | `/api/recordings/stop` | Stop the current capture (SIGINT, so ffmpeg finalizes the file cleanly) |
| GET | `/api/recordings` | JSON list: name, size, mtime, download URL |
| GET | `/recordings/<name>` | Download a recording (streamed with `Content-Disposition: attachment`; path-traversal safe) |
| GET | `/api/audio` | Live MP3 stream of the audio sink monitor (Chrome's output) |

```bash
curl -X POST http://127.0.0.1:8080/api/recordings/start
curl -X POST http://127.0.0.1:8080/api/recordings/stop
curl http://127.0.0.1:8080/api/recordings
curl -O http://127.0.0.1:8080/recordings/recording-2026-11-06T07-35-23.mkv
curl http://127.0.0.1:8080/api/audio --output live.mp3   # endless stream
```

Recordings are written to `/data/recordings/` (on the `/data` volume) as
`recording-<ISO-timestamp>.mkv`: H.264 video (1920×1080 @ 30 fps, captured
from the X display with ffmpeg `x11grab`) + AAC audio (captured from the
PulseAudio `vnc-audio` null sink that Chrome outputs into).

**Audio plumbing:** PulseAudio runs in user mode as the `media` user (it
refuses root), exposing a TCP native protocol on container-loopback
`127.0.0.1:4713`. The supervisor creates a null sink named `vnc-audio`,
makes it the default, and points Chrome at it, so recordings include the
browser's audio. VNC/RFB itself has no audio channel — live audio is
exposed over the HTTP stream above instead.

## How it works

Everything is one Node process (`src/index.ts`) acting as the supervisor —
it replaced supervisord, the bash entrypoint, and the Python web UI:

```
┌──────────────────────────────────────────────────────────────┐
│ node dist/index.js  (PID 1, TypeScript supervisor)           │
│                                                              │
│  slim:   chrome (headless) ──► CDP 127.0.0.1:9222            │
│          cdp-proxy: 0.0.0.0:9223 ──► 127.0.0.1:9222          │
│                                                              │
│  record: xvfb ─► fluxbox ─► pulseaudio (as `media`, sink)    │
│          chrome (headed, DISPLAY=:99) ─► CDP as above        │
│          x11vnc :5900, noVNC :6080                           │
│          rec server :8080 ──► ffmpeg x11grab + pulse ─► .mkv │
└──────────────────────────────────────────────────────────────┘
```

- **Process supervision** (`src/managed-process.ts`) — each child is spawned
  with a `[name]` log prefix and restarted with backoff when it exits.
  SIGTERM/SIGINT shut everything down in reverse order.
- **CDP watchdog** (`src/chrome.ts`) — Chrome can come back from a crash with
  its process alive but DevTools never bound (a stale `SingletonLock` in the
  profile). The supervisor polls `http://127.0.0.1:9222/json/version`; if it
  goes quiet, it clears the stale locks and restarts Chrome. Stale locks are
  also cleared before every automatic restart.
- **CA import** (`src/ca.ts`) — Chrome validates TLS against its own NSS
  store, not the system store. If a CA file is mounted at `$CA_FILE`
  (default `/usr/local/share/ca-certificates/spartans-root.crt`), it is
  imported into Chrome's NSS db (`certutil`) at startup; absent file = no-op.
  This lets a private gateway CA work inside Chrome without baking it into
  the image.
- **Profile persistence** — Chrome's `--user-data-dir` defaults to
  `/data/profile`. Mount a volume there (`./profile:/data` in compose) and
  logins/cookies survive restarts. **The profile is gitignored** — deleting
  it wipes the browser. Use a separate path for the slim and record images
  if you run both (or just run one at a time; they share the volume in the
  compose file).

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `MODE` | `slim` | `slim` or `record` — set by the image; override only for hacking. |
| `DATA_DIR` | `/data` | Root of the persistent volume. |
| `CHROME_USER_DATA_DIR` | `$DATA_DIR/profile` | Chrome profile directory. |
| `RECORDINGS_DIR` | `$DATA_DIR/recordings` | Where recordings are written (record mode). |
| `CHROME_BIN` | `/usr/bin/google-chrome-stable` | Chrome binary. |
| `CDP_PORT` | `9223` | External CDP port (the proxy). |
| `CDP_INTERNAL_PORT` | `9222` | Chrome's own loopback DevTools port. |
| `HEADFUL` | `1` in record mode | Run Chrome headed under Xvfb instead of `--headless=new`. Slim has no X stack, so headed only works in the record image. |
| `DISPLAY` | `:99` | X display (record mode). |
| `GEOMETRY` | `1920x1080` | Screen size / capture size (record mode). |
| `REC_PORT` | `8080` | Recording UI port (record mode). |
| `VNC_PORT` / `NOVNC_PORT` | `5900` / `6080` | VNC / noVNC ports (record mode). |
| `CA_FILE` | `/usr/local/share/ca-certificates/spartans-root.crt` | Optional CA to import into Chrome's NSS store. |

## Building

```bash
docker build --target slim   -t stealth-chrome:slim   .
docker build --target record -t stealth-chrome:record .
```

Or locally without Docker (needs Node ≥ 20):

```bash
npm ci
npm run build        # tsc -> dist/
npm run typecheck
MODE=slim node dist/index.js   # needs a Chrome binary + DATA_DIR writable
```

Layout:

```
Dockerfile                  multi-target: slim + record stages
docker-compose.yml          pull-and-run compose (slim default, record via --profile record)
.github/workflows/build.yml build + push both images to GHCR on every push
src/
  index.ts                  entrypoint/supervisor (replaces supervisord)
  config.ts                 env-var config
  managed-process.ts        spawn/restart/log child processes
  chrome.ts                 Chrome launch + CDP watchdog
  ca.ts                     optional CA import into Chrome's NSS store
  services/
    cdp-proxy.ts            9223 -> 9222 HTTP proxy, Host rewritten to loopback (replaces socat)
    display.ts              Xvfb + fluxbox + x11vnc + noVNC
    audio.ts                PulseAudio (as `media`) + vnc-audio sink
  rec/
    server.ts               recording web UI + API (replaces the Python one)
    ui.ts                   the web UI page
assets/pulse-default.pa     PulseAudio config for the `media` user
```

## Development / local overrides

`docker-compose.local.yml` is gitignored — use it for machine-specific
stuff (extra networks, mounting a private CA at
`/usr/local/share/ca-certificates/spartans-root.crt`, etc.) without
committing it. The public compose file intentionally has no such dependency,
so anyone can `docker compose up` it as-is.

## Troubleshooting

- **CDP unreachable from the host but fine inside the container** — you're
  hitting 9222. Chrome only listens on container-loopback; use **9223**
  (the proxy) from outside.
- **Chrome exits with "profile appears to be in use" (exit 21)** — a stale
  `SingletonLock` from a killed container. The supervisor clears it before
  restarts; if you run Chrome yourself, delete
  `SingletonLock`/`SingletonCookie`/`SingletonSocket` in the profile dir.
  Also don't point two containers at the same profile at once.
- **Recording has no audio** — check the record image is running (PulseAudio
  + sink are record-only) and that `/api/status` reports a running capture;
  the server re-creates the `vnc-audio` sink when you start a recording.
- **Port already in use** — the compose file maps 9223/8080/6080/5900 on
  localhost. Change the host side of the mapping if your machine has
  something else there.
