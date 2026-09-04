import type { ZodType } from "zod";

/* Zod's own message is the issues array as JSON, which a route would send to a
   user verbatim. This names the field and says what is wrong with it. */
export function readable(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

// One shape for every 400 a malformed request earns, so no route invents its own.
export function parseRequest<T>(schema: ZodType<T>, input: unknown): Parsed<T> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: readable(parsed.error) };
}
