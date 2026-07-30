import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import type { DockerManifest } from "@nightwarden/shared";

import { startWebSocketClient, type TransportOptions } from "../client.js";

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

const MANIFEST: DockerManifest = {
  platform: "docker",
  hostname: "test-host",
  runnerVersion: "3.0.0",
  services: [],
};

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function options(port: number, over: Partial<TransportOptions> = {}) {
  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    token: "test-token",
    dispatch: new Map(),
    buildManifest: () => Promise.resolve(MANIFEST),
    logger: silentLogger,
    ...over,
  };
}

describe("runner WS client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the manifest it advertises", () => {
    // The transport is handed a builder rather than importing one, which is what
    // lets the same client carry a Docker runner and a Kubernetes runner.
    it("sends whatever manifest its builder returns, on connect", async () => {
      const { wss, port } = await listen();
      const connected = nextConnection(wss);
      const stop = startWebSocketClient(options(port));
      try {
        const serverSocket = await connected;
        const message = await new Promise<string>((resolve) => {
          serverSocket.on("message", (raw) => resolve(String(raw)));
        });
        expect(JSON.parse(message)).toMatchObject({
          type: "manifest",
          payload: { platform: "docker", hostname: "test-host" },
        });
      } finally {
        stop();
        wss.close();
      }
    });
  });

  describe("command dispatch", () => {
    it("answers an unknown command with a failure rather than silence", async () => {
      const { wss, port } = await listen();
      const connected = nextConnection(wss);
      const stop = startWebSocketClient(options(port));
      try {
        const serverSocket = await connected;
        const replies: string[] = [];
        serverSocket.on("message", (raw) => replies.push(String(raw)));
        serverSocket.send(
          JSON.stringify({
            messageId: "m1",
            type: "command",
            payload: {
              commandName: "GetK8sLogs",
              commandInput: {},
              correlationId: "c1",
            },
          }),
        );

        const result = await vi.waitFor(() => {
          const found = replies
            .map((r) => JSON.parse(r) as Record<string, unknown>)
            .find((m) => m["type"] === "result");
          expect(found).toBeDefined();
          return found!;
        });
        expect(result["payload"]).toMatchObject({
          correlationId: "c1",
          success: false,
          error: "Unknown command: GetK8sLogs",
        });
      } finally {
        stop();
        wss.close();
      }
    });
  });

  describe("reconnect backoff", () => {
    // A runner the API accepts and then rejects (revoked token, wrong platform)
    // opens successfully every time. Clearing the backoff on open would pin it to
    // the first rung, so it would retry every two seconds forever and the API
    // would log the rejection just as often.
    it("escalates when the API keeps closing an opened connection", async () => {
      const { wss, port } = await listen();
      let opened = 0;
      wss.on("connection", (socket) => {
        opened++;
        socket.close(4004, "wrong platform");
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stop = startWebSocketClient(options(port));
      try {
        await vi.waitFor(() => expect(opened).toBe(1));
        await flushIo();

        // First rung is 2s.
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => expect(opened).toBe(2));
        await flushIo();

        // Second rung is 4s, so 2s more must NOT be enough.
        await vi.advanceTimersByTimeAsync(2_000);
        await flushIo();
        expect(opened).toBe(2);

        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => expect(opened).toBe(3));
      } finally {
        vi.useRealTimers();
        stop();
        wss.close();
      }
    });
  });

  describe("liveness", () => {
    it("answers a server ping with a protocol pong", async () => {
      const { wss, port } = await listen();
      const connected = nextConnection(wss);
      const stop = startWebSocketClient(options(port));
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
      // Only setTimeout is faked: the watchdog and the reconnect backoff are
      // timeouts; the manifest interval stays real and never fires in-test.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const connected = nextConnection(wss);
      const stop = startWebSocketClient(options(port));
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const connected = nextConnection(wss);
      const stop = startWebSocketClient(options(port));
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
