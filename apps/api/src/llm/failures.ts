import { APICallError } from "@ai-sdk/provider";
import { MAX_RETRIES, retryDelaysMs } from "./config.js";

function providerStatus(err: unknown): number | undefined | null {
  // null: not a provider error at all; undefined: provider connection error.
  return APICallError.isInstance(err) ? err.statusCode : null;
}

// The socket faults worth waiting out, the set the SDK itself marks retryable
// when it wraps a fetch failure.
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// A drop mid-stream can arrive raw rather than wrapped as an APICallError, so
// the cause chain is walked for a network code or a fetch-failure message.
function isRetryableNetworkError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) {
      return true;
    }
    if (/fetch failed|failed to fetch/i.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Outages, rate limits and dropped connections are worth waiting out; auth,
// model and request errors are not, since retrying them cannot succeed.
export function isTransientLLMError(err: unknown): boolean {
  if (APICallError.isInstance(err)) {
    return err.isRetryable === true || err.statusCode === undefined;
  }
  return isRetryableNetworkError(err);
}

interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  err: unknown;
}

export function retrySummary(notice: RetryNotice): string {
  const status = providerStatus(notice.err);
  const cause =
    typeof status === "number"
      ? `Provider error (${status})`
      : "Connection error";
  const seconds = Math.round(notice.delayMs / 1000);
  return `${cause}. Retrying in ${seconds}s - attempt ${notice.attempt + 1} of ${notice.maxAttempts}.`;
}

// OpenRouter nests the upstream host's name in error.metadata; surface it so
// "who actually failed" is readable without server logs.
function upstreamProvider(body: unknown): string | null {
  return metadataField(body, "provider_name");
}

// OpenRouter's canonical error code, which distinguishes "the model's upstream
// host is down" from "your key is bad" - very different things to act on.
function errorType(body: unknown): string | null {
  return metadataField(body, "error_type");
}

// Every provider wraps its fault the same way, in an object under `error`.
function errorBody(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null) return null;
  const body = (data as Record<string, unknown>)["error"];
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : null;
}

function metadataField(data: unknown, field: string): string | null {
  const metadata = errorBody(data)?.["metadata"];
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function bodyMessage(data: unknown): string {
  const message = errorBody(data)?.["message"];
  return typeof message === "string" ? message : "";
}

// OpenRouter types this condition; Anthropic only words it, so both are read.
const CONTEXT_OVERFLOW_WORDING = [
  "prompt is too long",
  "context window",
  "context length",
];

function isContextOverflow(err: APICallError): boolean {
  if (errorType(err.data) === "context_length_exceeded") return true;
  const said = `${err.message} ${bodyMessage(err.data)}`.toLowerCase();
  return CONTEXT_OVERFLOW_WORDING.some((wording) => said.includes(wording));
}

// Plain-language failure text persisted into the transcript. One or two
// sentences a non-expert can act on, with the raw status in parentheses.
export function describeLLMError(err: unknown): string {
  if (!APICallError.isInstance(err)) {
    const message = err instanceof Error ? err.message : String(err);
    return `The run failed unexpectedly: ${message}`;
  }
  const status = err.statusCode;
  const attempts = MAX_RETRIES + 1;
  if (status === undefined) {
    return "Could not reach the model provider - the connection failed. Check the Base URL in Settings and your network, then send a message to try again.";
  }
  const from = upstreamProvider(err.data);
  const detail = ` (HTTP ${status}${from === null ? "" : ` from ${from}`})`;
  // The host actually serving the model is down, which is neither your key nor
  // your model being wrong: another model routes around it.
  if (errorType(err.data) === "provider_unavailable") {
    return `The provider behind this model returned nothing usable, which means it is having an outage rather than anything being wrong with your setup. Try another model in Settings, or wait for it to recover${detail}.`;
  }
  if (status === 401 || status === 403) {
    return `The provider rejected the API key. Check the key under Settings, Provider${detail}.`;
  }
  if (status === 402) {
    return `The provider account is out of credits. Top up, or pick a model that costs less, in Settings${detail}.`;
  }
  if (status === 404) {
    return `The provider has no such model. It may have been renamed, retired, or moved behind a paid plan. Pick a different model in Settings${detail}.`;
  }
  // Checked before the generic 400 it arrives as: the user changed nothing,
  // so naming their model and reasoning level points at the wrong screen.
  if (isContextOverflow(err)) {
    return `This conversation grew past the model's context window, so the provider refused it. Continuing this session would hit the same limit: start a new one, or pick a model with a larger context window under Settings, Provider${detail}.`;
  }
  if (status === 400) {
    return `The provider rejected the request as malformed. If you have just changed the model or its reasoning level, check them under Settings, Provider${detail}.`;
  }
  if (status === 429) {
    return `The provider rate-limited the request, or a quota on the chosen model ran out. NightWarden tried ${attempts} times before giving up; this usually clears on its own${detail}.`;
  }
  if (status >= 500) {
    return `The model provider had a server problem - this is upstream, not your setup. NightWarden tried ${attempts} times before giving up${detail}.`;
  }
  return `The provider returned an unexpected error${detail}.`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// The only retry mechanism, since the SDKs' own are off, so the configured count
// is the real one. Abort cuts the sleep and rethrows the original error.
export async function withLLMRetries<T>(
  fn: () => Promise<T>,
  opts: {
    signal?: AbortSignal;
    delays?: readonly number[];
    onRetry?: (notice: RetryNotice) => void;
  } = {},
): Promise<T> {
  const delays = opts.delays ?? retryDelaysMs(MAX_RETRIES);
  const maxAttempts = delays.length + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delayMs = delays[attempt - 1];
      if (
        delayMs === undefined ||
        !isTransientLLMError(err) ||
        opts.signal?.aborted
      ) {
        throw err;
      }
      opts.onRetry?.({ attempt, maxAttempts, delayMs, err });
      await sleep(delayMs, opts.signal);
      if (opts.signal?.aborted) throw err;
    }
  }
}
