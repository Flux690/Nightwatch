import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";

// Mock the system boundaries the manifest probe touches so detectCapabilities
// resolves fast and deterministically (both probes fail closed to available:false).
vi.mock("../docker/client.js", () => ({
  getDocker: () => ({ listContainers: vi.fn() }),
}));
vi.mock("../kubernetes/client.js", () => ({
  getAppsV1Api: () => ({
    listDeploymentForAllNamespaces: vi.fn(),
    listStatefulSetForAllNamespaces: vi.fn(),
  }),
}));

import { startWebSocketClient } from "../websocket/client.js";

// Let real socket IO complete while timers are faked - setImmediate stays real.
async function flushIo(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function listen(): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  return { wss, port: (wss.address() as AddressInfo).port };
}

function nextConnection(wss: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => wss.once("connection", (s) => resolve(s)));
}

describe("runner WS client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("config validation", () => {
    it("throws a clear error when WS_URL is not set", () => {
      vi.stubEnv("WS_URL", "");
      expect(() => startWebSocketClient(new Map())).toThrow(/WS_URL/);
    });

    it("throws a clear error when WS_URL is absent from env", () => {
      delete process.env["WS_URL"];
      expect(() => startWebSocketClient(new Map())).toThrow(/WS_URL/);
    });
  });

  describe("liveness", () => {
    it("answers a server ping with a protocol pong", async () => {
      const { wss, port } = await listen();
      vi.stubEnv("WS_URL", `ws://127.0.0.1:${port}`);
      vi.stubEnv("NIGHTWATCH_TOKEN", "test-token");
      const connected = nextConnection(wss);
      const stop = startWebSocketClient(new Map());
      try {
        const serverSocket = await connected;
        const gotPong = new Promise<void>((resolve) => {
          serverSocket.on("pong", () => resolve());
        });
        serverSocket.ping();
        await gotPong;
      } finally {
        stop();
        wss.close();
      }
    });

    it("terminates the socket and reconnects when no ping arrives within the watchdog window", async () => {
      const { wss, port } = await listen();
      vi.stubEnv("WS_URL", `ws://127.0.0.1:${port}`);
      vi.stubEnv("NIGHTWATCH_TOKEN", "test-token");
      // Only setTimeout is faked: the watchdog and the reconnect backoff are
      // timeouts; the manifest interval stays real and never fires in-test.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const connected = nextConnection(wss);
      const stop = startWebSocketClient(new Map());
      try {
        const serverSocket = await connected;
        await flushIo();
        const closed = new Promise<void>((resolve) => {
          serverSocket.on("close", () => resolve());
        });

        await vi.advanceTimersByTimeAsync(90_000);
        await closed;

        // The close handler schedules the first backoff step (2s); advancing
        // it must produce a fresh connection.
        const reconnected = nextConnection(wss);
        await flushIo();
        await vi.advanceTimersByTimeAsync(2_000);
        await reconnected;
      } finally {
        vi.useRealTimers();
        stop();
        wss.close();
      }
    });

    it("a ping resets the watchdog, so a pinged connection stays up indefinitely", async () => {
      const { wss, port } = await listen();
      vi.stubEnv("WS_URL", `ws://127.0.0.1:${port}`);
      vi.stubEnv("NIGHTWATCH_TOKEN", "test-token");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const connected = nextConnection(wss);
      const stop = startWebSocketClient(new Map());
      try {
        const serverSocket = await connected;
        await flushIo();
        let closedEarly = false;
        serverSocket.on("close", () => {
          closedEarly = true;
        });

        // 180s of fake time, but never 90s without a ping.
        for (let i = 0; i < 3; i++) {
          serverSocket.ping();
          await flushIo();
          await vi.advanceTimersByTimeAsync(60_000);
        }
        await flushIo();
        expect(closedEarly).toBe(false);

        // Silence past the watchdog window now kills the socket.
        const closed = new Promise<void>((resolve) => {
          serverSocket.on("close", () => resolve());
        });
        await vi.advanceTimersByTimeAsync(90_000);
        await closed;
      } finally {
        vi.useRealTimers();
        stop();
        wss.close();
      }
    });
  });
});
