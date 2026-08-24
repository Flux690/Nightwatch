// A tool result arrives as a JSON string on the transcript wire and as an object
// on a live card, and every reader wants the same answer from it: an object, or
// nothing. One place asks that question, so a malformed result is handled once.

// The only assertion: JSON.parse returns `any`, and the checks above it are what
// make this narrowing true.
export function asRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export function numberAt(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringAt(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}
