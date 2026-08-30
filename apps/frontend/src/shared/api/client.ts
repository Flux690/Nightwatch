// The frontend's single fetch boundary: one place for status handling, so a failure
// throws an ApiError react-query surfaces instead of a swallowed `if (!res.ok) return`.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // The whole parsed body, not only the text lifted out of it: a caller that
    // must branch on a code needs the fields beside `error`.
    public readonly body: unknown = undefined,
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
    let body: unknown;
    try {
      // Project routes reply { error: string } on failure; prefer that text.
      body = (await res.json()) as { error?: unknown };
      const text = (body as { error?: unknown }).error;
      if (typeof text === "string") message = text;
    } catch {
      // Non-JSON error body (or none); keep the status-based message.
    }
    throw new ApiError(res.status, message, body);
  }

  if (res.status === 204) return undefined as T;
  try {
    // The one trusted cast in the frontend: responses are shape-checked at
    // compile time via @nightwarden/shared, a contract we own both ends of.
    return (await res.json()) as T;
  } catch {
    // A success with an empty or non-JSON body - the void endpoints (DELETE,
    // stop). Their callers type the result as void.
    return undefined as T;
  }
}
