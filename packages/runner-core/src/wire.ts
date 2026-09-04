// Decoding the untrusted side of the socket. A command's input arrives as JSON, so a
// registry that asserted its shape would be trusting the sender; this checks it.

import type { ZodType } from "zod";

/* Zod's own message is the issues array as JSON, and this one crosses back to the
   API as a command error the agent reads. Name the field and what is wrong. */
function readable(issues: readonly { path: PropertyKey[]; message: string }[]) {
  return issues
    .map((issue) =>
      issue.path.length > 0
        ? `"${issue.path.join(".")}" ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

export function decode<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(`invalid command input: ${readable(parsed.error.issues)}`);
}
