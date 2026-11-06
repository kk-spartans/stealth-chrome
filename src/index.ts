import { mkdir } from "node:fs/promises";
import { importCaIfPresent } from "./ca.js";
import { launchChrome, waitForCdp } from "./chrome.js";
import { config } from "./config.js";
import { error, log } from "./log.js";
import { ManagedProcess } from "./managed-process.js";
import { createRecordingServer } from "./rec/server.js";
import { startAudio } from "./services/audio.js";
import { startCdpProxy } from "./services/cdp-proxy.js";
import { startDisplay, startVnc } from "./services/display.js";

/**
 * Single entrypoint for both images.
 *
 *   MODE=slim   (default image)  Chrome headless + CDP only. Nothing else.
 *   MODE=record (record image)   Xvfb display + PulseAudio + VNC/noVNC +
 *                                headed Chrome + recording web UI on :8080.
 *
 * This process is the supervisor: it starts every child, restarts them
 * when they die, runs the CDP watchdog, and shuts everything down in
 * reverse order on SIGTERM/SIGINT. No supervisord, no bash scripts.
 */
const children: ManagedProcess[] = [];
let stopWatchdog: (() => void) | undefined;
let recording: ReturnType<typeof createRecordingServer> | undefined;
let cdpProxy: ReturnType<typeof startCdpProxy> | undefined;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("supervisor", `received ${signal} — shutting down`);
  stopWatchdog?.();
  cdpProxy?.close();
  try {
    await recording?.stop();
  } catch {
    /* already closed */
  }
  for (const child of [...children].reverse()) {
    await child.stop();
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main(): Promise<void> {
  log("supervisor", `starting stealth-chrome (mode=${config.mode})`);

  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.profileDir, { recursive: true });
  importCaIfPresent(config.caFile);

  if (config.mode === "record") {
    children.push(...(await startDisplay(config)));
    children.push(await startAudio(config));
  }

  const chrome = launchChrome(config);
  stopWatchdog = chrome.stopWatchdog;
  children.push(chrome.process);
  cdpProxy = startCdpProxy(config);

  if (config.mode === "record") {
    children.push(...startVnc(config));
    recording = createRecordingServer(config);
    await new Promise<void>((resolvePromise) => {
      recording!.server.listen(config.recPort, "0.0.0.0", () => {
        log("rec", `recording web UI on :${config.recPort}`);
        resolvePromise();
      });
    });
  }

  // Don't block forever if Chrome won't come up — the watchdog restarts it.
  try {
    await waitForCdp(config);
    log("chrome", `CDP ready (external :${config.cdpPort} -> internal :${config.cdpInternalPort})`);
  } catch (err) {
    error("chrome", `CDP did not come up: ${(err as Error).message} (watchdog will retry)`);
  }

  // Park forever; children + watchdog keep the container alive.
  await new Promise<void>(() => undefined);
}

main().catch((err: unknown) => {
  error("supervisor", `fatal: ${(err as Error).message}`);
  process.exit(1);
});
