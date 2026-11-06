import { connect, createServer, type Server, type Socket } from "node:net";
import type { Config } from "../config.js";
import { log } from "../log.js";

/**
 * TCP forwarder: external CDP port -> Chrome's loopback DevTools port.
 *
 * Chrome binds DevTools to 127.0.0.1 only (it ignores
 * --remote-debugging-address=0.0.0.0 in current versions), so a port
 * published straight to 9222 is unreachable from outside the container.
 * This replaces the old socat cdp-forward with ~30 lines of TypeScript:
 * listen on 0.0.0.0:<cdpPort>, pipe each socket to 127.0.0.1:<internal>.
 */
export function startCdpProxy(config: Config): Server {
  const server = createServer((client: Socket) => {
    const upstream = connect(config.cdpInternalPort, "127.0.0.1");
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  server.on("error", (err: Error) => {
    log("cdp-proxy", `error: ${err.message}`);
  });
  server.listen(config.cdpPort, "0.0.0.0", () => {
    log(
      "cdp-proxy",
      `CDP proxy on :${config.cdpPort} -> 127.0.0.1:${config.cdpInternalPort}`,
    );
  });
  return server;
}
