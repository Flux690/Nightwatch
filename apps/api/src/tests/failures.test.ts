import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  isTransientLLMError,
  retrySummary,
  withLLMRetries,
} from "../llm/failures.js";

function openAIError(status: number): Error {
  return OpenAI.APIError.generate(
    status,
    { error: { message: "boom" } },
    "boom",
    new Headers(),
  );
}

describe("isTransientLLMError", () => {
  it.each([408, 429, 500, 502, 503, 529])("retries HTTP %d", (status) => {
    expect(isTransientLLMError(openAIError(status))).toBe(true);
  });

  it("retries connection errors (no HTTP status)", () => {
    expect(
      isTransientLLMError(new OpenAI.APIConnectionError({ message: "down" })),
    ).toBe(true);
    expect(
      isTransientLLMError(
        new Anthropic.APIConnectionError({ message: "down" }),
      ),
    ).toBe(true);
  });

  it("retries Anthropic 5xx the same as OpenAI", () => {
    expect(
      isTransientLLMError(
        Anthropic.APIError.generate(
          529,
          { error: { message: "overloaded" } },
          "overloaded",
          new Headers(),
        ),
      ),
    ).toBe(true);
  });

  it.each([400, 401, 402, 403, 404])(
    "does not retry HTTP %d - a retry cannot succeed",
    (status) => {
      expect(isTransientLLMError(openAIError(status))).toBe(false);
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
        if (calls < 3) return Promise.reject(openAIError(502));
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
          return Promise.reject(openAIError(401));
        },
        { delays: [1, 1], onRetry },
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("throws the last error once every delay is used up", async () => {
    let calls = 0;
    await expect(
      withLLMRetries(
        () => {
          calls++;
          return Promise.reject(openAIError(503));
        },
        { delays: [1, 1] },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3);
  });

  it("abort during the backoff sleep rethrows promptly instead of waiting", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = withLLMRetries(() => Promise.reject(openAIError(502)), {
      delays: [60_000],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ status: 502 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("retrySummary", () => {
  it("names the HTTP status and the upcoming attempt", () => {
    expect(
      retrySummary({
        attempt: 1,
        maxAttempts: 4,
        delayMs: 15_000,
        err: openAIError(502),
      }),
    ).toBe("Provider error (502). Retrying in 15s - attempt 2 of 4.");
  });

  it("labels connection failures without inventing a status", () => {
    expect(
      retrySummary({
        attempt: 3,
        maxAttempts: 4,
        delayMs: 45_000,
        err: new OpenAI.APIConnectionError({ message: "down" }),
      }),
    ).toBe("Connection error. Retrying in 45s - attempt 4 of 4.");
  });
});
