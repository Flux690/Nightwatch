import { describe, expect, it } from "vitest";
import { redactSecrets, capOutput } from "../safety/allowlist.js";

describe("redactSecrets", () => {
  describe("key-value patterns (JSON, YAML, env)", () => {
    it("redacts a password= assignment", () => {
      const { content, redactedCount } = redactSecrets("password=s3cr3t-pass!");
      expect(content).not.toContain("s3cr3t-pass!");
      expect(content).toContain("[REDACTED]");
      expect(redactedCount).toBe(1);
    });

    it("redacts a JSON password field", () => {
      const { content } = redactSecrets('{"password": "hunter2"}');
      expect(content).not.toContain("hunter2");
      expect(content).toContain("[REDACTED]");
    });

    it("redacts a token: value line", () => {
      const { content } = redactSecrets("token: abc123XYZ");
      expect(content).not.toContain("abc123XYZ");
      expect(content).toContain("[REDACTED]");
    });

    it("redacts a secret=value assignment", () => {
      const { content } = redactSecrets("secret=my-secret-value");
      expect(content).not.toContain("my-secret-value");
    });

    it("preserves the key name when redacting key=value", () => {
      const { content } = redactSecrets("api_key=ABCD1234");
      expect(content).toContain("api_key");
      expect(content).not.toContain("ABCD1234");
    });

    it("redacts credential and access_key forms", () => {
      const { content: c1 } = redactSecrets("credential=mysecretcredential");
      const { content: c2 } = redactSecrets("access_key=MYACCESSKEYVALUE");
      expect(c1).not.toContain("mysecretcredential");
      expect(c2).not.toContain("MYACCESSKEYVALUE");
    });
  });

  describe("JWT tokens", () => {
    it("redacts a JWT found in a Bearer header", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.SflKxwRJSMeKKF2QT4fw";
      const { content, redactedCount } = redactSecrets(
        `Authorization: Bearer ${jwt}`,
      );
      expect(content).not.toContain(jwt);
      expect(content).toContain("[REDACTED]");
      expect(redactedCount).toBe(1);
    });

    it("redacts a JWT with no surrounding context", () => {
      const jwt =
        "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIn0.ABCDEF";
      const { content } = redactSecrets(jwt);
      expect(content).not.toContain("eyJhbGci");
    });
  });

  describe("PEM private keys", () => {
    it("redacts a PEM RSA private key block", () => {
      const pem =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----";
      const { content, redactedCount } = redactSecrets(pem);
      expect(content).not.toContain("MIIEpAIBAAKCAQEA1234");
      expect(content).toContain("[REDACTED]");
      expect(redactedCount).toBe(1);
    });

    it("redacts a generic PRIVATE KEY block (PKCS#8 form)", () => {
      const pem =
        "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2Vd\n-----END PRIVATE KEY-----";
      const { content } = redactSecrets(pem);
      expect(content).not.toContain("MC4CAQAwBQYDK2Vd");
    });
  });

  describe("cloud provider keys", () => {
    it("redacts an AWS access key ID", () => {
      const { content, redactedCount } = redactSecrets(
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      );
      expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(content).toContain("[REDACTED]");
      expect(redactedCount).toBeGreaterThanOrEqual(1);
    });

    it("redacts a Google API key", () => {
      const { content } = redactSecrets(
        "GOOGLE_API_KEY=AIzaSyD-9tSrke72I6gHMfoAASXlB9MrFaHm5bk",
      );
      expect(content).not.toContain("AIzaSyD-9tSrke72I6gHMfoAASXlB9MrFaHm5bk");
    });

    it("redacts a GitHub PAT (ghp_ prefix) via the dedicated rule", () => {
      const pat = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
      const { content } = redactSecrets(pat);
      expect(content).not.toContain(pat);
      expect(content).toBe("[REDACTED]");
    });

    it("redacts a Slack bot token", () => {
      const { content } = redactSecrets(
        "SLACK_TOKEN=xoxb-12345-67890-abcdefghijklmno",
      );
      expect(content).not.toContain("xoxb-12345-67890-abcdefghijklmno");
    });

    it("redacts a Stripe secret key", () => {
      const { content } = redactSecrets(
        "STRIPE_KEY=sk_live_ABCDEFGHIJKLMNOPQRSTUV",
      );
      expect(content).not.toContain("sk_live_ABCDEFGHIJKLMNOPQRSTUV");
    });

    it("redacts an npm automation token", () => {
      const token = "npm_" + "A".repeat(36);
      const { content } = redactSecrets(`NPM_TOKEN=${token}`);
      expect(content).not.toContain(token);
    });

    it("does not leave a double-redaction artifact when a cloud-key rule and the key-value rule both target the same value", () => {
      const token = "npm_" + "A".repeat(36);
      const { content } = redactSecrets(`NPM_TOKEN=${token}`);
      expect(content).toBe("NPM_TOKEN=[REDACTED]");
    });
  });

  describe("connection strings", () => {
    it("redacts a PostgreSQL connection string", () => {
      const { content, redactedCount } = redactSecrets(
        "DATABASE_URL=postgresql://user:s3cret@db.internal:5432/mydb",
      );
      expect(content).not.toContain("s3cret");
      expect(content).toContain("[REDACTED]");
      expect(redactedCount).toBeGreaterThanOrEqual(1);
    });

    it("redacts a Redis URL", () => {
      const { content } = redactSecrets(
        "CACHE_URL=redis://default:redispass@cache:6379",
      );
      expect(content).not.toContain("redispass");
    });

    it("redacts a MongoDB connection string", () => {
      const { content } = redactSecrets(
        "MONGO_URI=mongodb://admin:mongopass@mongo:27017/db",
      );
      expect(content).not.toContain("mongopass");
    });
  });

  describe("high-entropy tokens (entropy pass)", () => {
    it("redacts a high-entropy alphanumeric token not matched by keyword rules", () => {
      // This token has no keyword prefix; only entropy catches it.
      const token = "K9rGpP9mN2xQvL3wHjRtZaDcEbFsUyMoWiVnYeXq";
      const { content, redactedCount } = redactSecrets(
        `DEPLOY_HMAC_SIGNATURE=${token}`,
      );
      expect(content).not.toContain(token);
      expect(redactedCount).toBeGreaterThanOrEqual(1);
    });

    it("does not redact short normal identifiers", () => {
      const { content } = redactSecrets("container-id=abc123");
      expect(content).toContain("abc123");
    });

    it("does not redact normal log lines", () => {
      const { content } = redactSecrets(
        "Starting server on port 8080 in production mode",
      );
      expect(content).toBe("Starting server on port 8080 in production mode");
    });

    it("does not redact a file path even if long", () => {
      const { content } = redactSecrets("/var/log/nginx/access.log");
      expect(content).toBe("/var/log/nginx/access.log");
    });
  });

  describe("return value", () => {
    it("returns redactedCount 0 when nothing to redact", () => {
      const { redactedCount } = redactSecrets("hello world, port=8080");
      expect(redactedCount).toBe(0);
    });

    it("returns the original string unchanged when nothing matches", () => {
      const input = "INFO: server started successfully";
      const { content } = redactSecrets(input);
      expect(content).toBe(input);
    });

    it("counts multiple redactions across multiple rule matches", () => {
      const input = "password=abc123 token=xyz789";
      const { redactedCount } = redactSecrets(input);
      expect(redactedCount).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("capOutput", () => {
  it("returns short output unchanged", () => {
    const text = "hello world";
    expect(capOutput(text)).toBe(text);
  });

  it("caps output over 64 KB with an elision marker", () => {
    const big = "x".repeat(70 * 1024);
    const capped = capOutput(big);
    expect(capped).toContain("[... ");
    expect(capped).toContain("bytes elided");
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThan(big.length);
  });

  it("preserves the head and tail of the output", () => {
    const head = "HEAD_CONTENT ";
    const tail = " TAIL_CONTENT";
    const middle = "M".repeat(70 * 1024);
    const big = head + middle + tail;
    const capped = capOutput(big);
    expect(capped).toContain("HEAD_CONTENT");
    expect(capped).toContain("TAIL_CONTENT");
  });

  it("returns exactly 64 KB of content plus the elision marker for very large input", () => {
    const big = "A".repeat(200 * 1024);
    const capped = capOutput(big);
    // The elided section reports the missing bytes
    expect(capped).toMatch(/\[...\s+\d+ bytes elided\s+\.\.\.\]/);
  });

  it("accepts a custom maxBytes limit", () => {
    const text = "x".repeat(100);
    const capped = capOutput(text, 40);
    expect(capped).toContain("bytes elided");
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThan(text.length);
  });
});
