import { describe, expect, it } from "vitest";
import { capOutput, redactSecrets, sanitizeLines } from "../redact.js";

describe("redactSecrets", () => {
  describe("key-value patterns (JSON, YAML, env)", () => {
    /* One rule over a keyword list, so a keyword is a row rather than a case.
       Each is a distinct word the pattern has to know. */
    it.each([
      ["password=s3cr3t-pass!", "s3cr3t-pass!"],
      ['{"password": "hunter2"}', "hunter2"],
      ["token: abc123XYZ", "abc123XYZ"],
      ["secret=my-secret-value", "my-secret-value"],
      ["credential=mysecretcredential", "mysecretcredential"],
      ["access_key=MYACCESSKEYVALUE", "MYACCESSKEYVALUE"],
      ["api_key=ABCD1234", "ABCD1234"],
    ])("redacts the value in %s", (line, secret) => {
      const { content } = redactSecrets(line);
      expect(content).not.toContain(secret);
      expect(content).toContain("[REDACTED]");
    });

    it("preserves the key name when redacting key=value", () => {
      const { content } = redactSecrets("api_key=ABCD1234");
      expect(content).toContain("api_key");
      expect(content).not.toContain("ABCD1234");
    });

    it("redacts a quoted value with spaces in full (no leak after the first space)", () => {
      const { content } = redactSecrets('password = "my secret pass phrase"');
      expect(content).not.toContain("secret");
      expect(content).not.toContain("phrase");
      expect(content).toContain("password");
      expect(content).toContain("[REDACTED]");
    });

    it("redacts a short value the old four-char minimum would have skipped", () => {
      const { content } = redactSecrets("token=abc");
      expect(content).not.toContain("abc");
      expect(content).toContain("[REDACTED]");
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

  it("does not split a multibyte character into a replacement char at the cut", () => {
    // Each emoji is 4 UTF-8 bytes, so an arbitrary byte cut lands mid-character;
    // a naive byte slice would decode the split halves as U+FFFD.
    const big = "😀".repeat(40_000);
    const capped = capOutput(big);
    expect(capped).toContain("bytes elided");
    expect(capped).not.toContain("�");
  });
});

describe("sanitizeLines", () => {
  // A PEM key spans many lines, so per-line matching would miss every one of them;
  // the lines are sanitized as one document and re-split.
  it("redacts a private key that spans several lines", () => {
    const lines = [
      "starting up",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAtR4bF9mK2xQ",
      "9dLpXvN3jH8sYgTzR1cWqE5uOaP",
      "-----END RSA PRIVATE KEY-----",
      "ready",
    ];

    const out = sanitizeLines(lines).join("\n");

    expect(out).not.toContain("MIIEowIBAAKCAQEAtR4bF9mK2xQ");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("starting up");
    expect(out).toContain("ready");
  });
});
