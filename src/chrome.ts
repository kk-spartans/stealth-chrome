import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { log, warn } from "./log.js";
import { ManagedProcess, waitFor } from "./managed-process.js";

export function chromeArgs(config: Config): string[] {
  const [width, height] = config.geometry.split("x");
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    // Chrome binds DevTools to loopback only; the TS CDP proxy forwards
    // the external port to this one (see services/cdp-proxy.ts).
    `--remote-debugging-port=${config.cdpInternalPort}`,
    "--remote-allow-unsafe-websocket-origin",
    `--user-data-dir=${config.profileDir}`,
    `--window-size=${width ?? "1920"},${height ?? "1080"}`,
  ];
  if (config.headful) {
    args.push(`--display=${config.display}`);
  } else {
    args.push("--headless=new");
  }
  args.push("about:blank");
  return args;
}

export async function cdpHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForCdp(config: Config, timeoutMs = 60_000): Promise<void> {
  await waitFor(
    `Chrome DevTools on :${config.cdpInternalPort}`,
    () => cdpHealthy(config.cdpInternalPort),
    timeoutMs,
    1000,
  );
}

/**
 * Launch Chrome and keep it honest.
 *
 * Chrome can come back from a crash with its process alive but its
 * DevTools port never bound (a stale SingletonLock in the profile does
 * it), and a plain process supervisor has no idea. Poll the CDP
 * endpoint; if it goes quiet, clear the stale locks and restart Chrome.
 */
function clearStaleLocks(profileDir: string): void {
  for (const stale of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    // No existsSync() guard: Singleton* are symlinks to hostnames/pids or
    // /tmp paths that are gone in a fresh container, i.e. dangling links —
    // existsSync() follows them and reports false, so the stale lock would
    // never actually be removed. rmSync with force handles all cases.
    try {
      rmSync(join(profileDir, stale), { force: true });
    } catch {
      /* best effort */
    }
  }
}

export function launchChrome(config: Config): {
  process: ManagedProcess;
  stopWatchdog: () => void;
} {
  const proc = new ManagedProcess({
    name: "chrome",
    command: config.chromeBin,
    args: chromeArgs(config),
    env: {
      ...process.env,
      ...(config.headful ? { DISPLAY: config.display } : {}),
    },
    // A crashed/killed Chrome leaves SingletonLock behind and the next
    // start refuses the profile (exit 21) — clear it before every restart.
    beforeRestart: () => clearStaleLocks(config.profileDir),
  });
  proc.start();

  let lastRestart = 0;
  const timer = setInterval(async () => {
    if (await cdpHealthy(config.cdpInternalPort)) return;
    // Give a just-started Chrome time to bind the port before panicking.
    if (Date.now() - lastRestart < 30_000) return;
    lastRestart = Date.now();
    warn("cdp-watchdog", "CDP not responding — clearing stale locks and restarting Chrome");
    clearStaleLocks(config.profileDir);
    proc.killOnce();
  }, 30_000);
  timer.unref();

  log("chrome", `CDP expected on 127.0.0.1:${config.cdpInternalPort} (profile: ${config.profileDir})`);
  return { process: proc, stopWatchdog: () => clearInterval(timer) };
}
