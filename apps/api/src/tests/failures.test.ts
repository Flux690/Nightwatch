import { describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import {
  describeLLMError,
  isTransientLLMError,
  retrySummary,
  withLLMRetries,
} from "../llm/failures.js";

// One shape for every provider: the SDK reports each fault as an APICallError
// carrying the status and the body it was given.
function providerError(status: number, data?: unknown): APICallError {
  return new APICallError({
    message: "boom",
    url: "https://provider.example/v1/messages",
    requestBodyValues: {},
    statusCode: status,
    ...(data !== undefined && { data }),
  });
}

// A request that never reached a server, which carries no status.
function connectionError(): APICallError {
  return new APICallError({
    message: "down",
    url: "https://provider.example/v1/messages",
    requestBodyValues: {},
  });
}

describe("isTransientLLMError", () => {
  it.each([408, 429, 500, 502, 503, 529])("retries HTTP %d", (status) => {
    expect(isTransientLLMError(providerError(status))).toBe(true);
  });

  it("retries connection errors (no HTTP status)", () => {
    expect(isTransientLLMError(connectionError())).toBe(true);
  });

  it.each([400, 401, 402, 403, 404])(
    "does not retry HTTP %d - a retry cannot succeed",
    (status) => {
      expect(isTransientLLMError(providerError(status))).toBe(false);
    },
  );

  it("does not retry non-provider errors", () => {
    expect(isTransientLLMError(new Error("bug"))).toBe(false);
    expect(isTransientLLMError("string")).toBe(false);
  });
});

describe("withLLMRetries", () => {
  it("returns the first success after transient failures, reporting each retry", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const result = await withLLMRetries(
      () => {
        calls++;
        if (calls < 3) return Promise.reject(providerError(502));
        return Promise.resolve("ok");
      },
      { delays: [1, 1, 1], onRetry },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 4,
      delayMs: 1,
    });
  });

  it("throws immediately on a non-transient error, without retrying", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    await expect(
      withLLMRetries(
        () => {
          calls++;
          return Promise.reject(providerError(401));
        },
        { delays: [1, 1], onRetry },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("throws the last error once every delay is used up", async () => {
    let calls = 0;
    await expect(
      withLLMRetries(
        () => {
          calls++;
          return Promise.reject(providerError(503));
        },
        { delays: [1, 1] },
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toBe(3);
  });

  it("abort during the backoff sleep rethrows promptly instead of waiting", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = withLLMRetries(() => Promise.reject(providerError(502)), {
      delays: [60_000],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ statusCode: 502 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("describeLLMError", () => {
  it("names the upstream host on a 5xx, from OpenRouter's error metadata", () => {
    // Shape mirrors a real OpenRouter 502: the failing host rides in metadata.
    const err = providerError(502, {
      error: {
        message: "Provider returned error",
        metadata: { provider_name: "Poolside", is_byok: false },
      },
    });
    const text = describeLLMError(err);
    expect(text).toContain("server problem");
    expect(text).toContain("not your setup");
    expect(text).toContain("(HTTP 502 from Poolside)");
  });

  it.each([
    [401, "rejected the API key"],
    [402, "out of credits"],
    [404, "no such model"],
    [429, "rate-limited"],
  ])("maps HTTP %d to actionable words", (status, phrase) => {
    expect(describeLLMError(providerError(status))).toContain(phrase);
  });

  it("tells a 404 apart from a malformed request, since only one means the model is gone", () => {
    expect(describeLLMError(providerError(404))).toContain("retired");
    expect(describeLLMError(providerError(400))).toContain("malformed");
  });

  it("keeps the 429 wording provider-neutral, since this text serves both", () => {
    // One provider's free-tier numbers here would be wrong for the other. The
    // per-model caution lives on the model, where the adapter knows it.
    const text = describeLLMError(providerError(429));

    expect(text).toContain("rate-limited");
    expect(text).not.toContain("Free models");
  });

  it("reads provider_unavailable as an upstream outage rather than a setup problem", () => {
    // OpenRouter returns this when the host behind a model answers with nothing
    // usable: a different condition from a bad key, and it reads differently.
    const err = providerError(502, {
      error: {
        message: "Provider returned error",
        metadata: {
          provider_name: "Poolside",
          error_type: "provider_unavailable",
        },
      },
    });

    const text = describeLLMError(err);

    expect(text).toContain("outage");
    expect(text).toContain("anything being wrong with your setup");
    expect(text).toContain("from Poolside");
  });

  // A context-length overflow is a 400, and the generic 400 wording points at a
  // model and reasoning level the user never touched.
  it("tells a context-length overflow apart from a malformed request", () => {
    const err = providerError(400, {
      error: {
        message: "This endpoint's maximum context length is 128000 tokens",
        metadata: {
          error_type: "context_length_exceeded",
          provider_code: "string_above_max_length",
        },
      },
    });

    const text = describeLLMError(err);

    expect(text).toContain("context window");
    expect(text).not.toContain("malformed");
    expect(text).not.toContain("reasoning level");
  });

  // Anthropic publishes no typed code for it, so the message is the only signal.
  it("recognises the same overflow when only the message says so", () => {
    const err = providerError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 235433 tokens > 200000 maximum",
      },
    });

    const text = describeLLMError(err);

    expect(text).toContain("context window");
    expect(text).not.toContain("malformed");
  });

  it("explains connection failures without a status code", () => {
    const text = describeLLMError(connectionError());
    expect(text).toContain("Could not reach the model provider");
    expect(text).not.toContain("HTTP");
  });

  it("falls back to the raw message for non-provider errors", () => {
    expect(describeLLMError(new Error("db locked"))).toBe(
      "The run failed unexpectedly: db locked",
    );
  });
});

describe("retrySummary", () => {
  it("names the HTTP status and the upcoming attempt", () => {
    expect(
      retrySummary({
        attempt: 1,
        maxAttempts: 4,
        delayMs: 15_000,
        err: providerError(502),
      }),
    ).toBe("Provider error (502). Retrying in 15s - attempt 2 of 4.");
  });

  it("labels connection failures without inventing a status", () => {
    expect(
      retrySummary({
        attempt: 3,
        maxAttempts: 4,
        delayMs: 45_000,
        err: connectionError(),
      }),
    ).toBe("Connection error. Retrying in 45s - attempt 4 of 4.");
  });
});
