import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathAllowed, openAllowedFile } from "../safety/paths.js";

describe("isPathAllowed", () => {
  afterEach(() => {
    delete process.env["FILE_ALLOWLIST"];
  });

  it("allows a path within an allowlisted root", () => {
    expect(isPathAllowed("/var/log/nginx/access.log")).toBe(true);
  });

  it("allows the exact allowlisted root", () => {
    expect(isPathAllowed("/var/log")).toBe(true);
  });

  it("rejects .. traversal out of an allowed root", () => {
    expect(isPathAllowed("/var/log/../../etc/shadow")).toBe(false);
  });

  it("rejects a sibling-prefix path", () => {
    // /etc/app is allowlisted but /etc/app-secrets must not be
    expect(isPathAllowed("/etc/app-secrets")).toBe(false);
  });

  it("rejects a symlink inside an allowed directory that points outside it", () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "nw-allowlist-"));
    const allowed = path.join(outer, "allowed");
    fs.mkdirSync(allowed);
    const target = path.join(outer, "secret.txt");
    fs.writeFileSync(target, "secret");
    const link = path.join(allowed, "escape");
    fs.symlinkSync(target, link);
    process.env["FILE_ALLOWLIST"] = allowed;
    try {
      expect(isPathAllowed(link)).toBe(false);
    } finally {
      fs.unlinkSync(link);
      fs.unlinkSync(target);
      fs.rmdirSync(allowed);
      fs.rmdirSync(outer);
    }
  });

  it("allows a legitimate read via the env var extension", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-allowlist-"));
    process.env["FILE_ALLOWLIST"] = tmpDir;
    try {
      expect(isPathAllowed(path.join(tmpDir, "app.log"))).toBe(true);
    } finally {
      fs.rmdirSync(tmpDir);
    }
  });

  it("rejects a path outside all allowlisted roots", () => {
    expect(isPathAllowed("/home/user/passwords.txt")).toBe(false);
  });
});

describe("openAllowedFile", () => {
  afterEach(() => {
    delete process.env["FILE_ALLOWLIST"];
  });

  it("opens and reads a file inside an allowlisted root", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-openfile-"));
    const file = path.join(dir, "app.log");
    fs.writeFileSync(file, "hello\nworld\n");
    process.env["FILE_ALLOWLIST"] = dir;
    try {
      const handle = await openAllowedFile(file);
      try {
        expect(await handle.readFile("utf8")).toBe("hello\nworld\n");
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an existing file outside every allowlisted root", async () => {
    // A real file in tmp, which is under none of the default allowlist roots, so
    // the open succeeds but the canonical-path check rejects it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-openfile-"));
    const file = path.join(dir, "passwords.txt");
    fs.writeFileSync(file, "secret");
    try {
      await expect(openAllowedFile(file)).rejects.toThrow(/not in allowlist/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a symlink inside an allowed dir that escapes it", async () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "nw-openfile-"));
    const allowed = path.join(outer, "allowed");
    fs.mkdirSync(allowed);
    const target = path.join(outer, "secret.txt");
    fs.writeFileSync(target, "secret");
    const link = path.join(allowed, "escape");
    fs.symlinkSync(target, link);
    process.env["FILE_ALLOWLIST"] = allowed;
    try {
      await expect(openAllowedFile(link)).rejects.toThrow(/not in allowlist/i);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it("refuses to read a directory as a file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-openfile-"));
    process.env["FILE_ALLOWLIST"] = dir;
    try {
      // A directory opens read-only on POSIX but is not a regular file; the
      // fstat guard rejects it before any read.
      await expect(openAllowedFile(dir)).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
