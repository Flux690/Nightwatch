import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { MAX_RETRIES, retryDelaysMs } from "./config.js";

function providerStatus(err: unknown): number | undefined | null {
  // null: not a provider error at all; undefined: provider connection error.
  if (err instanceof OpenAI.APIError || err instanceof Anthropic.APIError) {
    return err.status;
  }
  return null;
}

// Outages, rate limits, and dropped connections are worth waiting out;
// auth/model/request errors are not - retrying them cannot succeed.
export function isTransientLLMError(err: unknown): boolean {
  const status = providerStatus(err);
  if (status === null) return false;
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  );
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

function metadataField(body: unknown, field: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const metadata = (body as Record<string, unknown>)["metadata"];
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

// Plain-language failure text persisted into the transcript. One or two
// sentences a non-expert can act on, with the raw status in parentheses.
export function describeLLMError(err: unknown): string {
  if (
    !(err instanceof OpenAI.APIError) &&
    !(err instanceof Anthropic.APIError)
  ) {
    const message = err instanceof Error ? err.message : String(err);
    return `The run failed unexpectedly: ${message}`;
  }
  const status = err.status;
  const attempts = MAX_RETRIES + 1;
  if (status === undefined) {
    return "Could not reach the model provider - the connection failed. Check the Base URL in Settings and your network, then send a message to try again.";
  }
  const from = upstreamProvider(err.error);
  const detail = ` (HTTP ${status}${from === null ? "" : ` from ${from}`})`;
  // The host actually serving the model is down, which is neither your key nor
  // your model being wrong: another model routes around it.
  if (errorType(err.error) === "provider_unavailable") {
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

// The only retry mechanism: the SDKs' own are switched off, so the configured
// count is the real one. Abort cuts the sleep and rethrows so the caller's stop
// handling sees the original error.
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
