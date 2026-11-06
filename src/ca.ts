import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log, warn } from "./log.js";

/**
 * Chrome on Linux validates TLS against its own NSS store, so the system
 * trust store (update-ca-certificates) does not apply to it. If a CA file
 * was mounted into the container (see CA_FILE, e.g. a private gateway
 * root), import it into Chrome's NSS db at startup — rotating the CA then
 * needs no image change. No-op when the file is absent (public use).
 *
 * Replaces chrome-entrypoint.sh.
 */
export function importCaIfPresent(caFile: string | undefined): void {
  if (!caFile || !existsSync(caFile)) return;
  try {
    const home = process.env.HOME ?? "/root";
    const db = join(home, ".pki", "nssdb");
    execFileSync("mkdir", ["-p", db]);
    // Delete-then-add keeps this idempotent across restarts / CA rotation.
    try {
      execFileSync("certutil", [
        "-d", `sql:${db}`, "-D", "-n", "spartans-root",
      ], { stdio: "ignore" });
    } catch {
      /* not present yet */
    }
    execFileSync("certutil", [
      "-d", `sql:${db}`, "-A", "-t", "C,,", "-n", "spartans-root", "-i", caFile,
    ], { stdio: "ignore" });
    log("ca", `imported ${caFile} into Chrome NSS store`);
  } catch (err) {
    warn("ca", `could not import ${caFile}: ${(err as Error).message}`);
  }
}
