import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import { error, log } from "../log.js";
import { ensureSink } from "../services/audio.js";
import { UI_HTML } from "./ui.js";

interface RecordingState {
  process: ChildProcess | null;
  path: string | null;
  startedAt: string | null;
}

interface RecordingInfo {
  name: string;
  size: number;
  mtime: number;
  url: string;
}

/**
 * Recording web UI + API — the TypeScript replacement for rec-webui (Python).
 *
 *   GET  /                       HTML UI
 *   GET  /api/status             recording status (json)
 *   POST /api/recordings/start   start an ffmpeg x11grab+pulse capture
 *   POST /api/recordings/stop    stop it (SIGINT so ffmpeg finalizes the .mkv)
 *   GET  /api/recordings         list recordings (json)
 *   GET  /recordings/<name>      download a recording (streamed, not buffered)
 *   GET  /api/audio              live MP3 stream of the audio sink monitor
 */
export function createRecordingServer(config: Config): {
  server: Server;
  stop: () => Promise<void>;
} {
  const state: RecordingState = { process: null, path: null, startedAt: null };
  const pulseEnv = {
    ...process.env,
    HOME: "/home/media",
    PULSE_SERVER: "tcp:127.0.0.1:4713",
    DISPLAY: config.display,
  };

  const recordingsDir = resolve(config.recordingsDir);

  async function listRecordings(): Promise<RecordingInfo[]> {
    await mkdir(recordingsDir, { recursive: true });
    const entries = await readdir(recordingsDir);
    const infos: RecordingInfo[] = [];
    for (const name of entries.sort().reverse()) {
      const full = join(recordingsDir, name);
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        infos.push({
          name,
          size: info.size,
          mtime: info.mtimeMs,
          url: `/recordings/${encodeURIComponent(name)}`,
        });
      } catch {
        /* file vanished mid-list */
      }
    }
    return infos;
  }

  function sendJson(res: ServerResponse, code: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function notFound(res: ServerResponse): void {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }

  async function handleStart(res: ServerResponse): Promise<void> {
    if (state.process && state.process.exitCode === null) {
      sendJson(res, 409, { error: "already recording" });
      return;
    }
    try {
      await ensureSink(pulseEnv);
    } catch (err) {
      error("rec", `ensure audio sink failed: ${(err as Error).message}`);
    }
    await mkdir(recordingsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = join(recordingsDir, `recording-${stamp}.mkv`);
    const proc = spawn(
      "ffmpeg",
      [
        "-y",
        "-f", "x11grab", "-framerate", "30",
        "-video_size", config.geometry,
        "-i", `${config.display}.0`,
        "-f", "pulse", "-i", "vnc-audio.monitor",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-f", "matroska",
        path,
      ],
      { env: pulseEnv, stdio: ["ignore", "ignore", "ignore"] },
    );
    state.process = proc;
    state.path = path;
    state.startedAt = new Date().toISOString();
    proc.on("exit", (code) => {
      log("rec", `ffmpeg exited (code=${code ?? "null"})`);
      if (state.process === proc) state.process = null;
    });
    log("rec", `recording started: ${path}`);
    sendJson(res, 200, { status: "started", path });
  }

  async function handleStop(res: ServerResponse): Promise<void> {
    const proc = state.process;
    if (!proc) {
      sendJson(res, 200, { status: "not recording" });
      return;
    }
    if (proc.exitCode === null) {
      // SIGINT lets ffmpeg finalize the matroska file cleanly.
      proc.kill("SIGINT");
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolvePromise();
        }, 15_000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }
    const path = state.path;
    state.process = null;
    state.path = null;
    log("rec", `recording stopped: ${path ?? ""}`);
    sendJson(res, 200, { status: "stopped", path });
  }

  async function serveDownload(res: ServerResponse, rawName: string): Promise<void> {
    // basename() + a resolved-prefix check kill any path traversal.
    const name = basename(decodeURIComponent(rawName));
    const full = resolve(join(recordingsDir, name));
    if (full !== recordingsDir && !full.startsWith(recordingsDir + sep)) {
      notFound(res);
      return;
    }
    let size: number;
    try {
      const info = await stat(full);
      if (!info.isFile()) return notFound(res);
      size = info.size;
    } catch {
      return notFound(res);
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Content-Length": size,
    });
    // Stream the file instead of reading it whole into memory.
    createReadStream(full).pipe(res);
  }

  function serveAudio(req: IncomingMessage, res: ServerResponse): void {
    const proc = spawn(
      "ffmpeg",
      ["-y", "-f", "pulse", "-i", "vnc-audio.monitor", "-f", "mp3", "-"],
      { env: pulseEnv, stdio: ["ignore", "pipe", "ignore"] },
    );
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    });
    proc.stdout?.pipe(res);
    const cleanup = (): void => {
      proc.kill("SIGTERM");
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    proc.on("error", (err) => {
      error("rec", `audio stream failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://internal");
      const path = url.pathname;

      if (req.method === "GET" && path === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(UI_HTML),
        });
        res.end(UI_HTML);
        return;
      }
      if (req.method === "GET" && path === "/api/status") {
        const alive = state.process !== null && state.process.exitCode === null;
        sendJson(res, 200, {
          recording: alive,
          path: state.path,
          started_at: state.startedAt,
        });
        return;
      }
      if (req.method === "GET" && path === "/api/recordings") {
        sendJson(res, 200, await listRecordings());
        return;
      }
      if (req.method === "GET" && path.startsWith("/recordings/")) {
        await serveDownload(res, path.slice("/recordings/".length));
        return;
      }
      if (req.method === "GET" && path === "/api/audio") {
        serveAudio(req, res);
        return;
      }
      if (req.method === "POST" && path === "/api/recordings/start") {
        await handleStart(res);
        return;
      }
      if (req.method === "POST" && path === "/api/recordings/stop") {
        await handleStop(res);
        return;
      }
      notFound(res);
    })().catch((err: unknown) => {
      error("rec", `request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  return {
    server,
    stop: async () => {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
      if (state.process && state.process.exitCode === null) {
        state.process.kill("SIGINT");
      }
    },
  };
}
