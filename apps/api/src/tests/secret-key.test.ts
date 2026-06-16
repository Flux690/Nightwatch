import "dotenv/config";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSecretKey } from "../config/secret-key.js";
import { encrypt, decrypt } from "../config/crypto.js";

function expectRestrictedPermissions(file: string): void {
  if (platform() === "win32") {
    const acl = execSync(`icacls "${file}"`).toString();
    expect(acl).not.toMatch(/Everyone/);
    expect(acl).not.toMatch(/BUILTIN\\Users/);
  } else {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
}

describe("resolveSecretKey", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nw-secret-key-"));
    vi.stubEnv("NIGHTWATCH_DB_PATH", join(dir, "nightwatch.db"));
    // dotenv/config may have loaded a real SECRET_KEY from .env; tests that
    // exercise self-provisioning need it genuinely absent.
    vi.stubEnv("SECRET_KEY", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses SECRET_KEY when the env var is set", () => {
    vi.stubEnv("SECRET_KEY", "an-explicit-secret");
    expect(resolveSecretKey()).toBe("an-explicit-secret");
  });

  it("generates a restricted-access key file beside the database when unset", () => {
    const key = resolveSecretKey();
    expect(key.length).toBeGreaterThan(0);

    const keyFile = join(dir, "secret.key");
    statSync(keyFile);
    expectRestrictedPermissions(keyFile);
  });

  it("regenerates when the key file exists but is empty (crash mid-write, full disk)", () => {
    const keyFile = join(dir, "secret.key");
    writeFileSync(keyFile, "", { mode: 0o600 });

    const key = resolveSecretKey();
    expect(key.length).toBeGreaterThan(0);
    expectRestrictedPermissions(keyFile);
  });

  it("creates the data directory on a truly fresh deploy where it doesn't exist yet", () => {
    const freshDir = join(dir, "not-yet-created");
    vi.stubEnv("NIGHTWATCH_DB_PATH", join(freshDir, "nightwatch.db"));

    const key = resolveSecretKey();
    expect(key.length).toBeGreaterThan(0);
    expectRestrictedPermissions(join(freshDir, "secret.key"));
  });

  it("reuses the same key across two boots (a value encrypted on boot 1 still decrypts on boot 2)", () => {
    const bootOneKey = resolveSecretKey();
    vi.stubEnv("SECRET_KEY", bootOneKey);
    const encrypted = encrypt("super-secret-llm-api-key");

    // Simulate a process restart: env unset again, file is all that remains.
    vi.stubEnv("SECRET_KEY", undefined);
    const bootTwoKey = resolveSecretKey();
    expect(bootTwoKey).toBe(bootOneKey);

    vi.stubEnv("SECRET_KEY", bootTwoKey);
    expect(decrypt(encrypted)).toBe("super-secret-llm-api-key");
  });
});
