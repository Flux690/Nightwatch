import { describe, expect, it, afterEach, vi } from "vitest";
import { startWebSocketClient } from "../websocket/client.js";

describe("startWebSocketClient config validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws a clear error when WS_URL is not set", () => {
    vi.stubEnv("WS_URL", "");
    expect(() => startWebSocketClient(new Map())).toThrow(/WS_URL/);
  });

  it("throws a clear error when WS_URL is absent from env", () => {
    delete process.env["WS_URL"];
    expect(() => startWebSocketClient(new Map())).toThrow(/WS_URL/);
  });
});
