import { request as httpRequest, createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Config } from "../config.js";
import { error, log } from "../log.js";

/**
 * HTTP-aware proxy: external CDP port -> Chrome's loopback DevTools port.
 *
 * Two problems force this to be more than a dumb TCP pipe (the old socat
 * cdp-forward had both):
 *
 * 1. Chrome binds DevTools to 127.0.0.1 only (it ignores
 *    --remote-debugging-address=0.0.0.0), so a port published straight to
 *    9222 is unreachable from outside the container.
 * 2. Chrome's DevTools rejects requests whose Host header is not a local
 *    host (HTTP 500 for `Host: browsers-chrome` or
 *    `Host: browsers.services.spartans` via the gateway). So every
 *    request — plain HTTP and websocket upgrades alike — gets its Host
 *    rewritten to 127.0.0.1:<internal> before it hits Chrome.
 *
 * As a bonus, /json/* responses get their webSocketDebuggerUrl rewritten
 * from 127.0.0.1:<internal> back to the caller's Host, so the URL Chrome
 * hands out is actually usable through the proxy/gateway.
 */
export function startCdpProxy(config: Config): Server {
  const internalHost = `127.0.0.1:${config.cdpInternalPort}`;

  const server = createServer((req, res) => {
    const callerHost = req.headers.host ?? internalHost;
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: config.cdpInternalPort,
        path: req.url ?? "/",
        method: req.method,
        headers: { ...req.headers, host: internalHost },
      },
      (upstreamRes) => {
        if ((req.url ?? "").startsWith("/json/")) {
          // Small JSON bodies — buffer and fix the debugger URL.
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (c: Buffer) => chunks.push(c));
          upstreamRes.on("end", () => {
            const body = Buffer.concat(chunks)
              .toString()
              .replaceAll(internalHost, callerHost);
            res.writeHead(upstreamRes.statusCode ?? 502, {
              ...upstreamRes.headers,
              "content-length": Buffer.byteLength(body),
            });
            res.end(body);
          });
          return;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err: Error) => {
      error("cdp-proxy", `upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end("bad gateway");
    });
    req.pipe(upstream);
  });

  // WebSocket upgrades (the actual CDP transport): rebuild the request
  // head with a loopback Host and pipe the raw sockets from there.
  server.on("upgrade", (req, socket: Socket, head: Buffer) => {
    const upstream = connect(config.cdpInternalPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url ?? "/"} HTTP/${req.httpVersion}`];
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const v = name.toLowerCase() === "host" ? internalHost : value;
        for (const single of Array.isArray(v) ? v : [v]) {
          lines.push(`${name}: ${single}`);
        }
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });

  server.on("error", (err: Error) => {
    log("cdp-proxy", `error: ${err.message}`);
  });
  server.listen(config.cdpPort, "0.0.0.0", () => {
    log(
      "cdp-proxy",
      `CDP proxy on :${config.cdpPort} -> 127.0.0.1:${config.cdpInternalPort} (Host rewritten to loopback)`,
    );
  });
  return server;
}
