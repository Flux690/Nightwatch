import { describe, it, expect, vi, afterEach } from "vitest";

import { installFetchInterceptor } from "../auth/fetchInterceptor.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("installFetchInterceptor", () => {
  it("calls onUnauthorized when a response has status 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    const onUnauthorized = vi.fn();
    installFetchInterceptor(onUnauthorized);

    await fetch("/api/sessions");

    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("does not call onUnauthorized for a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
    const onUnauthorized = vi.fn();
    installFetchInterceptor(onUnauthorized);

    await fetch("/api/sessions");

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("forwards arguments to the original fetch and returns its response untouched", async () => {
    const response = { ok: true, status: 200 };
    const originalFetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", originalFetch);
    installFetchInterceptor(vi.fn());

    const result = await fetch("/api/sessions", { method: "POST" });

    expect(originalFetch).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
    });
    expect(result).toBe(response);
  });

  it("uninstall restores the original fetch", async () => {
    const originalFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", originalFetch);

    const uninstall = installFetchInterceptor(vi.fn());
    expect(window.fetch).not.toBe(originalFetch);

    uninstall();

    expect(window.fetch).toBe(originalFetch);
  });
});
