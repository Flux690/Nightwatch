// Parses a runner token from an `Authorization: Bearer <token>` header. The
// Bearer prefix is required: a prefix-less, empty, or non-string header yields
// null, so a bare credential is never mistaken for a valid one.
export function extractBearerToken(
  authorization: string | string[] | undefined,
): string | null {
  if (typeof authorization !== "string") return null;
  const stripped = authorization.replace(/^Bearer\s+/i, "").trim();
  if (stripped.length === 0 || stripped === authorization) return null;
  return stripped;
}
