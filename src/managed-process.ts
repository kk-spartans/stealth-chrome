import { spawn, type ChildProcess } from "node:child_process";
import { error, log } from "./log.js";

/**
 * A child process the TypeScript supervisor keeps alive.
 *
 * Replaces supervisord: it restarts the process with a small backoff
 * whenever it exits, forwards its stdout/stderr with a [name] prefix,
 * and can be asked to restart itself (killOnce) — which is how the CDP
 * watchdog recovers a wedged Chrome without restarting the container.
 */
export interface ManagedProcessOptions {
  name: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Restart automatically when the process exits. Default: true. */
  restart?: boolean;
  restartDelayMs?: number;
  /** Run as this uid/gid (used for PulseAudio, which refuses root). */
  uid?: number;
  gid?: number;
  /** Called right before an automatic restart (e.g. clear stale locks). */
  beforeRestart?: () => void;
}

export class ManagedProcess {
  private readonly opts: ManagedProcessOptions;
  private child: ChildProcess | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;

  constructor(opts: ManagedProcessOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  start(): void {
    if (this.running) return;
    this.stopping = false;
    const { name, command, args = [], env, cwd, uid, gid } = this.opts;

    log(name, `starting: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      env: env ?? process.env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(uid !== undefined ? { uid } : {}),
      ...(gid !== undefined ? { gid } : {}),
    });
    this.child = child;

    pipeLines(name, child.stdout, "stdout");
    pipeLines(name, child.stderr, "stderr");

    child.on("error", (err) => {
      error(name, `spawn failed: ${(err as Error).message}`);
    });
    child.on("exit", (code, signal) => {
      this.child = undefined;
      log(name, `exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      if (this.stopping || this.opts.restart === false) return;
      const delay = this.opts.restartDelayMs ?? 1000;
      this.restartTimer = setTimeout(() => {
        this.opts.beforeRestart?.();
        this.start();
      }, delay);
    });
  }

  /** Kill the process once; the restart logic brings it back. */
  killOnce(): void {
    this.child?.kill("SIGTERM");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function pipeLines(
  name: string,
  stream: NodeJS.ReadableStream | null,
  _label: string,
): void {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      log(name, buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) log(name, buffer);
  });
}

/** Poll `predicate` until it returns true or `timeoutMs` elapses. */
export async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for: ${description}`);
}
