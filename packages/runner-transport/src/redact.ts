// Nothing a runner captured from a container reaches the API unredacted. Applied
// at the point raw text enters, so everything downstream already works on safe data.

interface RedactionRule {
  name: string;
  pattern: RegExp;
  preserve?: "key";
}

// Gitleaks-derived ruleset expressed as rules-as-data for extensibility. Order matters: more specific
// rules (JWT, PEM) run before the broad key-value sweep so a secret that matches both is counted only once.
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
    // Quoted values capture to the closing quote (spaces and all); unquoted run to the next delimiter. The
    // old pattern stopped at the first space and required >=4 chars, leaking spaced secrets and missing short ones.
    name: "key-value",
    pattern:
      /"?(password|passwd|token|secret|api_key|apikey|private_key|auth|credential|access_key|auth_token|access_token|client_secret)"?\s*[=:]\s*("[^"\n]*"|'[^'\n]*'|[^\s,\[\]\n]+)/gi,
    preserve: "key",
  },
];

// Entropy pass: catch high-entropy tokens not covered by explicit patterns.
const HIGH_ENTROPY_PATTERN = /[A-Za-z0-9+/=_.-]{20,}/g;
const ENTROPY_THRESHOLD = 3.7;

const MAX_OUTPUT_BYTES = 64 * 1024;

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

// Cap to maxBytes head+tail so both ends survive (the useful parts); cut on UTF-8
// character boundaries so a multibyte char isn't split into U+FFFD.
export function capOutput(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, utf8BoundaryBefore(buf, half)).toString("utf8");
  const tail = buf
    .subarray(utf8BoundaryAtOrAfter(buf, buf.length - half))
    .toString("utf8");
  const elided = buf.length - maxBytes;
  return `${head}\n[... ${elided} bytes elided ...]\n${tail}`;
}

// UTF-8 continuation bytes are 0b10xxxxxx. Move an offset back to the start of
// the character it lands in (so a head slice ends on a boundary)...
function utf8BoundaryBefore(buf: Buffer, offset: number): number {
  let o = offset;
  while (o > 0 && o < buf.length && (buf[o]! & 0xc0) === 0x80) o--;
  return o;
}

// ...and forward to the next character start (so a tail slice begins on one).
function utf8BoundaryAtOrAfter(buf: Buffer, offset: number): number {
  let o = offset;
  while (o < buf.length && (buf[o]! & 0xc0) === 0x80) o++;
  return o;
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

// The one rule for third-party text: cap first (bounds the work the redaction
// passes below do), then redact what remains.
export function sanitize(text: string): string {
  return redactSecrets(capOutput(text)).content;
}

// Log lines, sanitized as one document rather than line by line: a PEM private
// key spans many lines and per-line matching would miss every one of them.
export function sanitizeLines(lines: string[]): string[] {
  return sanitize(lines.join("\n")).split("\n");
}
