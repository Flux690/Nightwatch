// The console's single fetch boundary: one place for status handling, so a failure
// throws an ApiError react-query surfaces instead of a swallowed `if (!res.ok) return`.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  // Call with a single arg for plain reads so the request is fetch(url), not
  // fetch(url, undefined) - identical behaviour, but it keeps call sites simple.
  const res = init === undefined ? await fetch(url) : await fetch(url, init);

  if (!res.ok) {
    let message = `${init?.method ?? "GET"} ${url} failed (${res.status})`;
    try {
      // Project routes reply { error: string } on failure; prefer that text.
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Non-JSON error body (or none); keep the status-based message.
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  try {
    // The one trusted cast in the console: api responses are shape-checked at
    // compile time through @nightwatch/shared, so the boundary returns the
    // caller's declared T rather than re-validating a contract we own both ends of.
    return (await res.json()) as T;
  } catch {
    // A success with an empty or non-JSON body - the void endpoints (DELETE,
    // stop). Their callers type the result as void.
    return undefined as T;
  }
}
