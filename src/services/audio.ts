import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { ManagedProcess, waitFor } from "../managed-process.js";

const execFileAsync = promisify(execFile);

const SINK_NAME = "vnc-audio";
/**
 * Where every PulseAudio client (Chrome, ffmpeg, pactl) connects.
 * Chrome MUST get this in its environment — without it Chrome has no
 * idea the in-container PulseAudio exists and all audio is silently lost.
 */
export const PULSE_SERVER = "tcp:127.0.0.1:4713";

/**
 * PulseAudio in user mode so Chrome's audio lands in a null sink.
 *
 * PulseAudio refuses to run as root, so spawn it as the `media` user
 * (uid/gid lookup) instead of shelling out to `su`. Its config
 * (~/.config/pulse/default.pa) exposes a TCP native protocol on
 * 127.0.0.1:4713 with no dbus/system bus, so root Chrome and ffmpeg can
 * both connect over TCP. ffmpeg captures `<sink>.monitor` for recordings
 * and the live audio stream.
 */
export async function startAudio(_config: Config): Promise<ManagedProcess> {
  const uid = Number(execFileSync("id", ["-u", "media"], { encoding: "utf8" }).trim());
  const gid = Number(execFileSync("id", ["-g", "media"], { encoding: "utf8" }).trim());

  const env = {
    ...process.env,
    HOME: "/home/media",
    PULSE_SERVER,
  };

  const pulse = new ManagedProcess({
    name: "pulseaudio",
    command: "/usr/bin/pulseaudio",
    args: ["--daemonize=no", "--log-target=stderr", "--exit-idle-time=-1"],
    env,
    uid,
    gid,
  });
  pulse.start();

  await waitFor(
    "PulseAudio native protocol",
    async () => pactl(env, ["info"]).then(() => true, () => false),
    15_000,
  );
  await ensureSink(env);
  return pulse;
}

/** Create the vnc-audio null sink if missing and make it the default. Idempotent. */
export async function ensureSink(env: NodeJS.ProcessEnv): Promise<void> {
  const { stdout } = await pactl(env, ["list", "short", "sinks"]);
  if (stdout.includes(SINK_NAME)) return;
  await pactl(env, [
    "load-module", "module-null-sink",
    `sink_name=${SINK_NAME}`,
    "sink_properties=device.description=VNC_AUDIO",
  ]);
  await pactl(env, ["set-default-sink", SINK_NAME]);
  log("pulseaudio", `created default sink ${SINK_NAME}`);
}

function pactl(env: NodeJS.ProcessEnv, args: string[]): Promise<{ stdout: string }> {
  return execFileAsync("pactl", args, { env, timeout: 5000 });
}
