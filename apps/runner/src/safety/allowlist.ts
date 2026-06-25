import path from "node:path";
import fs from "node:fs";

const DEFAULT_ALLOWLIST = [
  "/etc/nginx",
  "/etc/app",
  "/var/log",
  "/proc/meminfo",
  "/proc/stat",
  "/proc/loadavg",
];

interface RedactionRule {
  name: string;
  pattern: RegExp;
  preserve?: "key";
}

// Gitleaks-derived ruleset expressed as rules-as-data for extensibility.
// Order matters: more specific rules (JWT, PEM) run before the broad key-value
// sweep so a secret that matches both is counted only once.
const RULES: RedactionRule[] = [
  {
    name: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  },
  {
    name: "pem-private-key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "aws-access-key",
    pattern: /AKIA[0-9A-Z]{16}/g,
  },
  {
    name: "google-api-key",
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
  },
  {
    name: "github-pat",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    name: "slack-token",
    pattern: /xox[baprs]-[0-9A-Za-z-]{10,}/g,
  },
  {
    name: "stripe-key",
    pattern: /(sk|pk|rk)_(test|live)_[A-Za-z0-9]{10,}/g,
  },
  {
    name: "npm-token",
    pattern: /npm_[A-Za-z0-9]{36}/g,
  },
  {
    name: "connection-string",
    pattern:
      /(postgresql|postgres|mysql|mongodb|redis|amqp|jdbc):\/\/[^\s"'`\n]+/gi,
  },
  {
    name: "key-value",
    pattern:
      /"?(password|passwd|token|secret|api_key|apikey|private_key|auth|credential|access_key|auth_token|access_token|client_secret)"?\s*[=:]\s*"?[^\s"',\[\]\n]{4,}/gi,
    preserve: "key",
  },
];

// Entropy pass: catch high-entropy tokens not covered by explicit patterns.
const HIGH_ENTROPY_PATTERN = /[A-Za-z0-9+/=_.-]{20,}/g;
const ENTROPY_THRESHOLD = 3.7;

const MAX_OUTPUT_BYTES = 64 * 1024;

export function isPathAllowed(filePath: string): boolean {
  const allowlist = buildAllowlist();
  const normalized = path.resolve(filePath);

  let resolved: string;
  let pathExists: boolean;
  try {
    resolved = fs.realpathSync(normalized);
    pathExists = true;
  } catch {
    resolved = normalized;
    pathExists = false;
  }

  return allowlist.some((allowed) => {
    const normalizedAllowed = path.resolve(allowed);
    let effectiveAllowed = normalizedAllowed;
    if (pathExists) {
      // allowlist entry may itself be a symlink (e.g. /var/log on macOS); resolve
      // both sides into the same namespace so the comparison is correct.
      try {
        effectiveAllowed = fs.realpathSync(normalizedAllowed);
      } catch {
        effectiveAllowed = normalizedAllowed;
      }
    }
    // "+" prevents /etc/app-secrets from matching the /etc/app allowlist entry.
    return (
      resolved === effectiveAllowed ||
      resolved.startsWith(effectiveAllowed + "/")
    );
  });
}

function buildAllowlist(): string[] {
  const env = process.env["FILE_ALLOWLIST"];
  return env
    ? [...DEFAULT_ALLOWLIST, ...env.split(":").filter(Boolean)]
    : DEFAULT_ALLOWLIST;
}

function shannonEntropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  const len = s.length;
  let e = 0;
  for (const n of Object.values(freq)) {
    const p = n / len;
    e -= p * Math.log2(p);
  }
  return e;
}

// Caps output to maxBytes using a head+tail strategy so both the beginning and
// the end of the output are preserved (the most diagnostically useful parts).
export function capOutput(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString("utf8");
  const tail = buf.subarray(buf.length - half).toString("utf8");
  const elided = buf.length - maxBytes;
  return `${head}\n[... ${elided} bytes elided ...]\n${tail}`;
}

export function redactSecrets(content: string): {
  content: string;
  redactedCount: number;
} {
  let redactedCount = 0;
  let result = content;

  for (const rule of RULES) {
    result = result.replace(rule.pattern, (match) => {
      redactedCount++;
      if (rule.preserve === "key") {
        const sepIdx = match.search(/[=:]/);
        return sepIdx === -1
          ? "[REDACTED]"
          : match.slice(0, sepIdx + 1) + " [REDACTED]";
      }
      return "[REDACTED]";
    });
  }

  // Entropy pass: any remaining token of 20+ chars with high Shannon entropy
  // that wasn't caught by an explicit rule is also redacted.
  result = result.replace(HIGH_ENTROPY_PATTERN, (token) => {
    if (shannonEntropy(token) >= ENTROPY_THRESHOLD) {
      redactedCount++;
      return "[REDACTED]";
    }
    return token;
  });

  return { content: result, redactedCount };
}

// Composition used by exec handlers: cap first (bounds the work the redaction
// passes below do), then redact what remains.
export function sanitizeExecOutput(text: string): string {
  return redactSecrets(capOutput(text)).content;
}
