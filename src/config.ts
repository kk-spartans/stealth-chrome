import { join } from "node:path";

export type Mode = "slim" | "record";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface Config {
  mode: Mode;
  /** Top of the persistent volume, e.g. /data */
  dataDir: string;
  /** Chrome --user-data-dir */
  profileDir: string;
  /** Recordings live under <dataDir>/recordings */
  recordingsDir: string;
  chromeBin: string;
  /** External CDP port (the TS proxy). This is the one to publish. */
  cdpPort: number;
  /** Chrome's own DevTools port — loopback only inside the container. */
  cdpInternalPort: number;
  /** X display for the record variant, e.g. :99 */
  display: string;
  /** e.g. 1920x1080 */
  geometry: string;
  recPort: number;
  vncPort: number;
  novncPort: number;
  /** Run Chrome headed under Xvfb instead of headless. */
  headful: boolean;
  /** Optional extra CA to import into Chrome's NSS store. */
  caFile: string | undefined;
}

function load(): Config {
  const mode: Mode = process.env.MODE === "record" ? "record" : "slim";
  const dataDir = process.env.DATA_DIR ?? "/data";
  return {
    mode,
    dataDir,
    profileDir: process.env.CHROME_USER_DATA_DIR ?? join(dataDir, "profile"),
    recordingsDir: process.env.RECORDINGS_DIR ?? join(dataDir, "recordings"),
    chromeBin: process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable",
    cdpPort: intEnv("CDP_PORT", 9223),
    cdpInternalPort: intEnv("CDP_INTERNAL_PORT", 9222),
    display: process.env.DISPLAY ?? ":99",
    geometry: process.env.GEOMETRY ?? "1920x1080",
    recPort: intEnv("REC_PORT", 8080),
    vncPort: intEnv("VNC_PORT", 5900),
    novncPort: intEnv("NOVNC_PORT", 6080),
    headful: process.env.HEADFUL === "1" || mode === "record",
    caFile:
      process.env.CA_FILE ??
      "/usr/local/share/ca-certificates/spartans-root.crt",
  };
}

export const config: Config = load();
