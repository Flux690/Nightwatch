import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSecrets } from "../secrets.js";
import { clearTestLLM, connectTestMetrics, useTempDb } from "./temp-db.js";
import { loadApiKey, loadConfig, seedConfigFromEnv } from "../config/store.js";
import { seedIntegrationsFromEnv } from "../integrations/seed.js";
import { metricsSourceRow } from "../integrations/metrics/store.js";
import { getDb } from "../db.js";
import { getLokiIntegration } from "../integrations/store.js";

// Every supported provider, as data: a new one is a row here, not a copied test,
// so it cannot be added without the seed being proven for it.
const PROVIDER_FAMILIES = [
  {
    provider: "anthropic",
    env: {
      ANTHROPIC_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_API_KEY: "sk-ant-seeded",
      ANTHROPIC_BASE_URL: "https://gateway.internal/anthropic",
    },
    model: "claude-sonnet-4-6",
    apiKey: "sk-ant-seeded",
    baseUrl: "https://gateway.internal/anthropic",
  },
  {
    provider: "openrouter",
    env: {
      OPENROUTER_MODEL: "anthropic/claude-opus-5",
      OPENROUTER_API_KEY: "sk-or-seeded",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    },
    model: "anthropic/claude-opus-5",
    apiKey: "sk-or-seeded",
    baseUrl: "https://openrouter.ai/api/v1",
  },
] as const;

// Env provisions an install once on first boot and is never a live source after.
// Each provider reads only its own prefix, so no block borrows another's.
describe("first-boot config seed from the environment", () => {
  let cleanupDb: () => void;

  beforeEach(async () => {
    cleanupDb = await useTempDb();
    await clearTestLLM();
  });

  afterEach(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it.each(PROVIDER_FAMILIES)(
    "seeds the $provider block from its own variables and activates it",
    async ({ provider, env, model, apiKey, baseUrl }) => {
      vi.stubEnv("NIGHTWARDEN_LLM_PROVIDER", provider);
      for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
      }

      await seedConfigFromEnv();

      const config = await loadConfig();
      expect(config.provider).toBe(provider);
      expect(config.providers[provider].model).toBe(model);
      expect(config.providers[provider].baseUrl).toBe(baseUrl);
      expect(await loadApiKey(provider)).toBe(apiKey);
    },
  );

  it("fills both blocks when both are specified, and activates only the one NIGHTWARDEN_LLM_PROVIDER names", async () => {
    vi.stubEnv("NIGHTWARDEN_LLM_PROVIDER", "openrouter");
    for (const family of PROVIDER_FAMILIES) {
      for (const [name, value] of Object.entries(family.env)) {
        vi.stubEnv(name, value);
      }
    }

    await seedConfigFromEnv();

    const config = await loadConfig();
    expect(config.provider).toBe("openrouter");
    // The unselected provider keeps its own credentials, ready to switch to.
    expect(config.providers.anthropic.model).toBe("claude-sonnet-4-6");
    expect(await loadApiKey("anthropic")).toBe("sk-ant-seeded");
  });

  it("seeds a block with no model at all, rather than inventing one", async () => {
    vi.stubEnv("NIGHTWARDEN_LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-no-model");

    await seedConfigFromEnv();

    const config = await loadConfig();
    expect(config.provider).toBeNull();
    expect(config.providers.anthropic.model).toBeNull();
    expect(await loadApiKey("anthropic")).toBeUndefined();
  });

  it("activates nothing without NIGHTWARDEN_LLM_PROVIDER, so credentials alone never start an agent", async () => {
    for (const [name, value] of Object.entries(PROVIDER_FAMILIES[0].env)) {
      vi.stubEnv(name, value);
    }

    await seedConfigFromEnv();

    const config = await loadConfig();
    expect(config.provider).toBeNull();
    // The block is still filled: the user only has to pick, not re-enter a key.
    expect(config.providers.anthropic.model).toBe("claude-sonnet-4-6");
  });

  it("leaves an already-configured install alone: env is a first-boot seed, not an override", async () => {
    vi.stubEnv("NIGHTWARDEN_LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-4-6");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-first");
    await seedConfigFromEnv();

    // The user then changes their mind in the frontend, and the box restarts
    // with the old environment still in its compose file.
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-4-8");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-second");
    await seedConfigFromEnv();

    expect((await loadConfig()).providers.anthropic.model).toBe(
      "claude-sonnet-4-6",
    );
    expect(await loadApiKey("anthropic")).toBe("sk-ant-first");
  });
});

// The evidence integrations follow the same rule, so a fresh install can come up
// fully configured without anyone opening a browser.
describe("first-boot integration seed from the environment", () => {
  let cleanupDb: () => void;

  beforeEach(async () => {
    cleanupDb = await useTempDb();
    vi.stubEnv(
      "NIGHTWARDEN_SECRET_KEY",
      "test-only-secret-key-for-seed-tests-32bytes",
    );
    initSecrets();
  });

  afterEach(() => {
    cleanupDb();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function answering(ok: boolean): ReturnType<typeof vi.fn> {
    return vi.fn(async () =>
      ok
        ? new Response(JSON.stringify({ status: "success", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("nope", { status: 502 }),
    );
  }

  it("seeds Prometheus and Loki once the probe answers", async () => {
    vi.stubEnv("PROMETHEUS_URL", "http://prom.internal:9090");
    vi.stubEnv("PROMETHEUS_AUTH_HEADER", "Bearer prom-secret");
    vi.stubEnv("LOKI_URL", "http://loki.internal:3100");
    vi.stubEnv("LOKI_ORG_ID", "tenant-a");
    vi.stubGlobal("fetch", answering(true));

    await seedIntegrationsFromEnv();

    expect(await metricsSourceRow()).toMatchObject({
      kind: "prometheus",
      queryUrl: "http://prom.internal:9090",
      // Prometheus serves its own rules, which is what makes recovery
      // verification work on a seeded install with nothing else configured.
      rulesUrl: "http://prom.internal:9090",
    });
    expect(await getLokiIntegration()).toMatchObject({
      baseUrl: "http://loki.internal:3100",
      orgId: "tenant-a",
    });
    // The accessor hands back plaintext; the column never holds it.
    expect((await metricsSourceRow())?.queryAuthorization).toBe(
      "Bearer prom-secret",
    );
    const stored = (await getDb()
      .selectFrom("integrations")
      .select("secrets")
      .where("kind", "=", "prometheus")
      .executeTakeFirst())!;
    expect(stored.secrets).not.toContain("prom-secret");
  });

  it("leaves an unreachable URL unconfigured rather than saving something broken", async () => {
    vi.stubEnv("PROMETHEUS_URL", "http://prom.internal:9090");
    vi.stubGlobal("fetch", answering(false));

    await seedIntegrationsFromEnv();

    expect(await metricsSourceRow()).toBeNull();
  });

  it("never overwrites an integration the user already connected", async () => {
    await connectTestMetrics({ queryUrl: "http://chosen-by-user:9090" });
    vi.stubEnv("PROMETHEUS_URL", "http://from-stale-compose-file:9090");
    const fetchMock = answering(true);
    vi.stubGlobal("fetch", fetchMock);

    await seedIntegrationsFromEnv();

    expect((await metricsSourceRow())?.queryUrl).toBe(
      "http://chosen-by-user:9090",
    );
    // Not even probed: the database already owns this one.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the variables are absent", async () => {
    await seedIntegrationsFromEnv();

    expect(await metricsSourceRow()).toBeNull();
    expect(await getLokiIntegration()).toBeNull();
  });
});
