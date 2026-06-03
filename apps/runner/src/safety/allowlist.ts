const DEFAULT_ALLOWLIST = [
  "/etc/nginx",
  "/etc/app",
  "/var/log",
  "/proc/meminfo",
  "/proc/stat",
  "/proc/loadavg",
];

const SECRET_PATTERN =
  /(password|passwd|token|secret|api_key|apikey|private_key)\s*[=:]\s*\S+/gi;

export function isPathAllowed(filePath: string): boolean {
  const allowlist = buildAllowlist();
  return allowlist.some((allowed) => filePath.startsWith(allowed));
}

function buildAllowlist(): string[] {
  const env = process.env["FILE_ALLOWLIST"];
  return env
    ? [...DEFAULT_ALLOWLIST, ...env.split(":").filter(Boolean)]
    : DEFAULT_ALLOWLIST;
}

export function redactSecrets(content: string): {
  content: string;
  redactedCount: number;
} {
  let redactedCount = 0;
  const redacted = content.replace(SECRET_PATTERN, (match) => {
    redactedCount++;
    const eqIdx = match.search(/[=:]/);
    return eqIdx === -1
      ? "[REDACTED]"
      : match.slice(0, eqIdx + 1) + " [REDACTED]";
  });
  return { content: redacted, redactedCount };
}
