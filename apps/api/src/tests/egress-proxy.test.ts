import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EGRESS_PROXY_SCRIPT } from "../sandbox/egress-proxy-script.js";

// Drives the real artifact: the same script string that ships in the proxy
// container, run via `node -e`, exercised through actual CONNECT requests.
let proxy: ChildProcess | null = null;
let upstream: Server | null = null;

// Pick a concrete free port up front and pass it in, so the ready-signal is a
// simple log-line match rather than parsing an OS-assigned port.
async function launch(
  port: number,
  env: Record<string, string>,
): Promise<void> {
  const child = spawn("node", ["-e", EGRESS_PROXY_SCRIPT], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxy = child;
  const stdout: string[] = [];
  child.stdout?.on("data", (d: Buffer) => stdout.push(d.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("proxy did not start")),
      3000,
    );
    child.stdout?.on("data", (d: Buffer) => {
      if (d.toString().includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  (child as unknown as { _out: string[] })._out = stdout;
}

function proxyStdout(): string {
  return (proxy as unknown as { _out: string[] })._out.join("");
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// Issue a raw CONNECT and resolve with the proxy's status line.
function doConnect(
  proxyPort: number,
  target: string,
): Promise<{ status: number; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    socket.on("data", (d: Buffer) => {
      buf += d.toString();
      const line = buf.split("\r\n")[0] ?? "";
      const m = /HTTP\/1\.1 (\d+)/.exec(line);
      if (m) resolve({ status: parseInt(m[1]!, 10), socket });
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
}

afterEach(() => {
  proxy?.kill("SIGKILL");
  proxy = null;
  upstream?.close();
  upstream = null;
});

describe("egress filtering proxy", () => {
  it("tunnels a CONNECT to an allowlisted host", async () => {
    // A loopback upstream stands in for the allowed host; ALLOW_PRIVATE lifts
    // the SSRF guard so 127.0.0.1 is reachable for the test only. The numeric
    // loopback avoids localhost's IPv4/IPv6 ambiguity against the upstream.
    const upstreamPort = await freePort();
    upstream = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) =>
      upstream!.listen(upstreamPort, "127.0.0.1", r),
    );

    const proxyPort = await freePort();
    await launch(proxyPort, {
      ALLOW: "127.0.0.1",
      ALLOW_PRIVATE: "1",
    });

    const { status, socket } = await doConnect(
      proxyPort,
      `127.0.0.1:${upstreamPort}`,
    );
    socket.destroy();
    expect(status).toBe(200);
    expect(proxyStdout()).not.toContain("BLOCKED");
  });

  it("refuses and logs a CONNECT to a host not on the allowlist", async () => {
    const proxyPort = await freePort();
    await launch(proxyPort, {
      ALLOW: "registry.npmjs.org",
      ALLOW_PRIVATE: "1",
    });

    const { status, socket } = await doConnect(
      proxyPort,
      "evil.example.com:443",
    );
    socket.destroy();
    expect(status).toBe(403);
    expect(proxyStdout()).toContain("BLOCKED evil.example.com");
  });

  it("refuses an allowlisted host that resolves to a private address (SSRF guard on)", async () => {
    const upstreamPort = await freePort();
    upstream = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) =>
      upstream!.listen(upstreamPort, "127.0.0.1", r),
    );

    // localhost is allowlisted AND resolves to 127.0.0.1, but with the guard
    // active (no ALLOW_PRIVATE) the proxy must still refuse the outbound.
    const proxyPort = await freePort();
    await launch(proxyPort, { ALLOW: "localhost" });

    const { status, socket } = await doConnect(
      proxyPort,
      `localhost:${upstreamPort}`,
    );
    socket.destroy();
    expect(status).toBe(403);
    expect(proxyStdout()).toContain("BLOCKED localhost");
  });
});
