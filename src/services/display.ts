import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { ManagedProcess, waitFor } from "../managed-process.js";

/** Xvfb + fluxbox — the virtual display the record variant captures. */
export async function startDisplay(config: Config): Promise<ManagedProcess[]> {
  const xvfb = new ManagedProcess({
    name: "xvfb",
    command: "/usr/bin/Xvfb",
    // -nolisten tcp: the X server must never be reachable over TCP, only
    // via the local unix socket — the display is not a network service.
    args: [config.display, "-screen", "0", `${config.geometry}x24`, "-nolisten", "tcp"],
  });
  xvfb.start();

  // Xvfb creates /tmp/.X11-unix/X<n> once it owns the display.
  const displayNumber = config.display.replace(/^:/, "");
  await waitFor(
    `X display ${config.display}`,
    () => existsSync(join("/tmp/.X11-unix", `X${displayNumber}`)),
    15_000,
  );

  const fluxbox = new ManagedProcess({
    name: "fluxbox",
    command: "/usr/bin/fluxbox",
    args: ["-display", config.display],
    env: { ...process.env, DISPLAY: config.display },
  });
  fluxbox.start();

  return [xvfb, fluxbox];
}

/** x11vnc + noVNC, for eyeballing the headed browser. No auth — keep it off the open internet. */
export function startVnc(config: Config): ManagedProcess[] {
  const vnc = new ManagedProcess({
    name: "x11vnc",
    command: "/usr/bin/x11vnc",
    args: [
      "-display", config.display,
      "-forever", "-shared", "-nopw",
      "-rfbport", String(config.vncPort),
    ],
    env: { ...process.env, DISPLAY: config.display },
  });
  vnc.start();

  const novnc = new ManagedProcess({
    name: "novnc",
    command: "/usr/bin/websockify",
    args: [
      `--web=/usr/share/novnc/`,
      String(config.novncPort),
      `localhost:${config.vncPort}`,
    ],
  });
  novnc.start();

  return [vnc, novnc];
}
