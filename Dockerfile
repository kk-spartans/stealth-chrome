# syntax=docker/dockerfile:1
# Two images from one Dockerfile:
#
#   --target slim    Chrome headless + CDP only. No X, no audio, no VNC,
#                    no recording. This is the image most people want.
#   --target record  Slim + Xvfb display + PulseAudio + ffmpeg recording
#                    web UI + VNC/noVNC. Headed Chrome, viewable + recordable.
#
# Real branded Google Chrome (not Chromium): Google sign-in refuses
# unbranded builds; a persistent profile logs in fine either way.
# Everything inside is managed by the TypeScript supervisor in src/ —
# no supervisord, no bash entrypoints, no Python.

# ---------- build: compile the TypeScript supervisor ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- slim: Chrome + CDP, and nothing else ----------
FROM node:22-bookworm-slim AS slim
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DATA_DIR=/data \
    CHROME_USER_DATA_DIR=/data/profile \
    CDP_PORT=9223 \
    MODE=slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates \
      fonts-liberation \
      libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 \
      libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libnss3-tools \
      libvulkan1 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 \
      libxkbcommon0 libxrandr2 libpango-1.0-0 libcairo2 libexpat1 \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && apt-get clean && rm -rf /var/lib/apt/lists

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

VOLUME /data
EXPOSE 9222 9223
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9223/json/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/dist/index.js"]

# ---------- record: slim + display/audio/VNC/recording ----------
FROM slim AS record
ENV MODE=record \
    DISPLAY=:99 \
    GEOMETRY=1920x1080 \
    REC_PORT=8080 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb fluxbox x11vnc websockify novnc \
      ffmpeg pulseaudio pulseaudio-utils \
    && useradd -m -s /bin/sh media \
    && ln -sf vnc.html /usr/share/novnc/index.html \
    && apt-get clean && rm -rf /var/lib/apt/lists

# PulseAudio user-mode config for `media`: TCP native protocol on
# 127.0.0.1:4713, auth-anonymous, no dbus/system bus required.
COPY assets/pulse-default.pa /home/media/.config/pulse/default.pa
RUN chown -R media:media /home/media/.config

EXPOSE 5900 6080 8080
