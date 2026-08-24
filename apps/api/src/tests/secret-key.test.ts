import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSecretKey, initSecrets, encrypt, decrypt } from "../secrets.js";

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
    vi.stubEnv("NIGHTWARDEN_DIR", dir);
    // setup.ts sets the suite-wide test key; self-provisioning tests need
    // NIGHTWARDEN_SECRET_KEY genuinely absent.
    vi.stubEnv("NIGHTWARDEN_SECRET_KEY", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    initSecrets();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses NIGHTWARDEN_SECRET_KEY when the env var is set", () => {
    vi.stubEnv("NIGHTWARDEN_SECRET_KEY", "an-explicit-secret");
    expect(resolveSecretKey()).toBe("an-explicit-secret");
  });

  it("generates a restricted-access key file in the state directory when unset", () => {
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

  it("creates the state directory on a truly fresh deploy where it doesn't exist yet", () => {
    const freshDir = join(dir, "not-yet-created");
    vi.stubEnv("NIGHTWARDEN_DIR", freshDir);

    const key = resolveSecretKey();
    expect(key.length).toBeGreaterThan(0);
    expectRestrictedPermissions(join(freshDir, "secret.key"));
  });

  it("reuses the same key across two boots (a value encrypted on boot 1 still decrypts on boot 2)", () => {
    initSecrets();
    const bootOneKey = resolveSecretKey();
    const encrypted = encrypt("super-secret-llm-api-key");

    // A restart with the env var still unset: the key file is all that remains.
    initSecrets();
    expect(resolveSecretKey()).toBe(bootOneKey);
    expect(decrypt(encrypted)).toBe("super-secret-llm-api-key");
  });
});
