// The egress filtering proxy, embedded as a string so it runs via `node -e` in
// the proxy container (no build copy, no bind mount) and stays self-contained -
// it executes with no access to this codebase. Env: PORT, ALLOW, ALLOW_PRIVATE.
export const EGRESS_PROXY_SCRIPT = String.raw`
const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ALLOW = (process.env.ALLOW || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === "1";

function hostOf(hostport) {
  const h = String(hostport).toLowerCase();
  const colon = h.lastIndexOf(":");
  // Keep IPv6 literals intact; only strip a trailing :port on a plain host.
  if (colon > -1 && h.indexOf(":") === colon) return h.slice(0, colon);
  return h;
}

// Suffix match: an entry allows itself and any subdomain, so "github.com"
// covers "codeload.github.com". Predictable and operator-editable.
function isAllowed(host) {
  return ALLOW.some((entry) => host === entry || host.endsWith("." + entry));
}

function isBlockedIp(ip) {
  if (ALLOW_PRIVATE) return false;
  const v = String(ip);
  if (v === "::1") return true;
  if (v.startsWith("127.")) return true;
  if (v.startsWith("10.")) return true;
  if (v.startsWith("192.168.")) return true;
  if (v.startsWith("169.254.")) return true; // link-local incl. cloud metadata
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(v)) return true;
  const low = v.toLowerCase();
  if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd"))
    return true;
  return false;
}

function deny(host) {
  console.log("BLOCKED " + host);
}

function resolvePublic(host, cb) {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err || !addrs || addrs.length === 0) return cb(null);
    const blocked = addrs.find((a) => isBlockedIp(a.address));
    if (blocked) return cb(null);
    cb(addrs[0].address);
  });
}

const server = http.createServer((req, res) => {
  // Plain HTTP proxying (rare for installs, which use HTTPS/CONNECT).
  let host;
  try {
    host = hostOf(new URL(req.url).host || req.headers.host || "");
  } catch {
    host = hostOf(req.headers.host || "");
  }
  if (!host || !isAllowed(host)) {
    deny(host || "unknown");
    res.writeHead(403);
    res.end("egress denied");
    return;
  }
  resolvePublic(host, (ip) => {
    if (!ip) {
      deny(host);
      res.writeHead(403);
      res.end("egress denied");
      return;
    }
    const u = new URL(req.url);
    const upstream = http.request(
      {
        host: ip,
        port: u.port || 80,
        method: req.method,
        path: u.pathname + u.search,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end("upstream error");
    });
    req.pipe(upstream);
  });
});

// HTTPS: the client sends CONNECT host:443, then does its own TLS over the
// tunnel, so the proxy never sees plaintext and the client's SNI is preserved.
server.on("connect", (req, clientSocket, head) => {
  const host = hostOf(req.url);
  const portStr = String(req.url).slice(host.length + 1);
  const port = parseInt(portStr, 10) || 443;
  if (!isAllowed(host)) {
    deny(host);
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.destroy();
    return;
  }
  resolvePublic(host, (ip) => {
    if (!ip) {
      deny(host);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(port, ip, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
});

server.listen(PORT, () => {
  console.log("egress proxy listening on " + PORT + " allow=" + ALLOW.join(","));
});
`;
