import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { LLM_RETRY_DELAYS_MS } from "./config.js";

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

export interface RetryNotice {
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

// The SDKs' built-in retries span ~2s - too short for a real provider blip.
// This ladder rides out outages; abort cuts the sleep and rethrows so the
// caller's stop handling sees the original error.
export async function withLLMRetries<T>(
  fn: () => Promise<T>,
  opts: {
    signal?: AbortSignal;
    delays?: readonly number[];
    onRetry?: (notice: RetryNotice) => void;
  } = {},
): Promise<T> {
  const delays = opts.delays ?? LLM_RETRY_DELAYS_MS;
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
