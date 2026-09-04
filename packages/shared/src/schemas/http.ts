import { z } from "zod";
import { PLATFORMS } from "../runner.js";

// A message the agent will read, so an all-whitespace one is empty rather than
// short. Trimmed here, which keeps every route from repeating the check.
const message = z
  .string({ error: "message is required" })
  .trim()
  .min(1, "message is required");

// Only a chat opens from a typed message: an investigation is a session with a
// falsifiable condition, and only an alert carries one.
export const chatRequestSchema = z.object({
  message,
  kind: z
    .literal("chat", {
      error: "an investigation is opened by an alert, not by hand",
    })
    .optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const sessionMessageRequestSchema = z.object({ message });
export type SessionMessageRequest = z.infer<typeof sessionMessageRequestSchema>;

/* Either half may stand alone: a decision with no comment settles a gate, and a
   comment with no decision answers a question. */
export const respondRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]).optional(),
  text: z.string().optional(),
});
export type RespondRequest = z.infer<typeof respondRequestSchema>;

// The name is only required to be a string here: serverNameError owns every
// rule about its content, so the route reports one voice rather than two.
export const mintTokenRequestSchema = z.object({
  platform: z.enum(PLATFORMS),
  serverName: z.string(),
});
export type MintTokenRequest = z.infer<typeof mintTokenRequestSchema>;

/* One message per bound, whatever the value failed on: a caller who sent "abc"
   needs to know what a limit is, not that coercing it produced NaN. */
const LIMIT = "limit must be a whole number from 1 to 200";
const OFFSET = "offset must be a whole number of 0 or more";

export const sessionPageQuerySchema = z.object({
  kind: z.enum(["investigation", "chat"]),
  limit: z.coerce
    .number({ error: LIMIT })
    .int(LIMIT)
    .min(1, LIMIT)
    .max(200, LIMIT)
    .default(50),
  offset: z.coerce
    .number({ error: OFFSET })
    .int(OFFSET)
    .min(0, OFFSET)
    .default(0),
});
export type SessionPageQuery = z.infer<typeof sessionPageQuerySchema>;
