import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { registerConsoleRoutes } from "../console.js";

const compress = promisify(brotliCompress);

// What the console build lays down: hashed files under assets/, verbatim public
// files beside them, and a .br for anything worth compressing.
async function buildFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nw-console-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "logos"), { recursive: true });

  const script = `console.log("app");${" ".repeat(2000)}`;
  await writeFile(join(root, "index.html"), "<!doctype html><div id=root>");
  await writeFile(join(root, "assets/index-AbCdEfGh.js"), script);
  await writeFile(
    join(root, "assets/index-AbCdEfGh.js.br"),
    await compress(script),
  );
  await writeFile(join(root, "logos/docker.svg"), "<svg />");
  return root;
}

describe("console static serving", () => {
  let server: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = await buildFixture();
    vi.stubEnv("NIGHTWARDEN_CONSOLE_DIST", root);
    server = Fastify();
    // Registered under a prefix in index.ts, so the guard has something to hit.
    await server.register(
      async (api) => {
        api.get("/sessions/:id", async () => ({ ok: true }));
      },
      { prefix: "/api" },
    );
    await registerConsoleRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  describe("caching", () => {
    it("lets a hashed asset be kept forever, because its name changes when it does", async () => {
      const res = await server.inject("/assets/index-AbCdEfGh.js");

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );
    });

    it("keeps index.html revalidating, because it names the hashed assets", async () => {
      const res = await server.inject("/index.html");

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("keeps an unhashed public file revalidating too", async () => {
      const res = await server.inject("/logos/docker.svg");

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });
  });

  describe("compression", () => {
    it("serves the prebuilt brotli when the browser accepts it", async () => {
      const res = await server.inject({
        url: "/assets/index-AbCdEfGh.js",
        headers: { "accept-encoding": "br" },
      });

      expect(res.headers["content-encoding"]).toBe("br");
      expect(res.headers["vary"]).toContain("accept-encoding");
      expect(res.rawPayload.byteLength).toBeLessThan(500);
    });

    it("serves the plain file to a browser that does not", async () => {
      const res = await server.inject({
        url: "/assets/index-AbCdEfGh.js",
        headers: { "accept-encoding": "identity" },
      });

      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.body).toContain('console.log("app")');
    });
  });

  describe("SPA routing", () => {
    it("answers a deep link with the app rather than a 404", async () => {
      const res = await server.inject("/sessions/abc123");

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<div id=root>");
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("leaves an unknown API path as JSON, so a fetch never parses HTML", async () => {
      const res = await server.inject("/api/nope");

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not found" });
    });

    it("does not answer a non-GET with the app", async () => {
      const res = await server.inject({ method: "POST", url: "/sessions" });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("a missing build", () => {
    afterEach(() => {
      vi.stubEnv("NIGHTWARDEN_CONSOLE_DIST", root);
      vi.stubEnv("NODE_ENV", "test");
    });

    // process.exit never returns, so a stub that does needs the cast.
    function stubExit() {
      return vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
    }

    it("serves the API alone in development, where Vite is serving the console", async () => {
      vi.stubEnv("NIGHTWARDEN_CONSOLE_DIST", join(root, "absent"));
      const exit = stubExit();
      const bare = Fastify();

      await registerConsoleRoutes(bare);
      await bare.ready();

      expect(exit).not.toHaveBeenCalled();
      expect((await bare.inject("/")).statusCode).toBe(404);
      exit.mockRestore();
      await bare.close();
    });

    it("refuses to boot in production, where the image always carries the console", async () => {
      vi.stubEnv("NIGHTWARDEN_CONSOLE_DIST", join(root, "absent"));
      vi.stubEnv("NODE_ENV", "production");
      const exit = stubExit();
      const bare = Fastify();

      await registerConsoleRoutes(bare);

      expect(exit).toHaveBeenCalledWith(1);
      exit.mockRestore();
      await bare.close();
    });
  });
});
