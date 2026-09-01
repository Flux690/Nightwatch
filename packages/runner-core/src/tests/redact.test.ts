import { describe, expect, it } from "vitest";
import { capOutput, redactSecrets, sanitizeLines } from "../redact.js";

const JWT_BEARER =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.SflKxwRJSMeKKF2QT4fw";
const JWT_BARE =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIn0.ABCDEF";
const RSA_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----";
const PKCS8_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2Vd\n-----END PRIVATE KEY-----";
const NPM_TOKEN = "npm_" + "A".repeat(36);

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

    it("redacts a value of any length, down to three characters", () => {
      const { content } = redactSecrets("token=abc");
      expect(content).not.toContain("abc");
      expect(content).toContain("[REDACTED]");
    });
  });

  /* The corpus: one shape per row, all asserting the only thing that matters -
     the secret is gone and something says so. A row is a pattern the rules have
     to know, so a new secret shape is a line rather than a block. */
  it.each([
    [
      "a JWT in a Bearer header",
      `Authorization: Bearer ${JWT_BEARER}`,
      JWT_BEARER,
    ],
    ["a JWT with no surrounding context", JWT_BARE, "eyJhbGci"],
    ["a PEM RSA private key", RSA_PEM, "MIIEpAIBAAKCAQEA1234"],
    ["a PEM key in PKCS#8 form", PKCS8_PEM, "MC4CAQAwBQYDK2Vd"],
    [
      "an AWS access key id",
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "AKIAIOSFODNN7EXAMPLE",
    ],
    [
      "a Google API key",
      "GOOGLE_API_KEY=AIzaSyD-9tSrke72I6gHMfoAASXlB9MrFaHm5bk",
      "AIzaSyD-9tSrke72I6gHMfoAASXlB9MrFaHm5bk",
    ],
    [
      "a Slack bot token",
      "SLACK_TOKEN=xoxb-12345-67890-abcdefghijklmno",
      "xoxb-12345-67890-abcdefghijklmno",
    ],
    [
      "a Stripe secret key",
      "STRIPE_KEY=sk_live_ABCDEFGHIJKLMNOPQRSTUV",
      "sk_live_ABCDEFGHIJKLMNOPQRSTUV",
    ],
    ["an npm automation token", `NPM_TOKEN=${NPM_TOKEN}`, NPM_TOKEN],
    [
      "a PostgreSQL connection string",
      "DATABASE_URL=postgresql://user:s3cret@db.internal:5432/mydb",
      "s3cret",
    ],
    [
      "a Redis URL",
      "CACHE_URL=redis://default:redispass@cache:6379",
      "redispass",
    ],
    [
      "a MongoDB connection string",
      "MONGO_URI=mongodb://admin:mongopass@mongo:27017/db",
      "mongopass",
    ],
    [
      "a high-entropy token no keyword rule matches",
      "DEPLOY_HMAC_SIGNATURE=K9rGpP9mN2xQvL3wHjRtZaDcEbFsUyMoWiVnYeXq",
      "K9rGpP9mN2xQvL3wHjRtZaDcEbFsUyMoWiVnYeXq",
    ],
  ])("redacts %s", (_shape, line, secret) => {
    const { content } = redactSecrets(line);
    expect(content).not.toContain(secret);
    expect(content).toContain("[REDACTED]");
  });

  // The count is the claim here: one secret must not be redacted twice by two
  // rules that both match it.
  it.each([
    ["a JWT in a Bearer header", `Authorization: Bearer ${JWT_BEARER}`],
    ["a PEM RSA private key", RSA_PEM],
  ])("redacts %s exactly once", (_shape, line) => {
    expect(redactSecrets(line).redactedCount).toBe(1);
  });

  it("redacts a GitHub PAT to nothing but the marker", () => {
    const { content } = redactSecrets(
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    );
    expect(content).toBe("[REDACTED]");
  });

  it("leaves no double-redaction artifact where a cloud-key rule and the key-value rule both match", () => {
    expect(redactSecrets(`NPM_TOKEN=${NPM_TOKEN}`).content).toBe(
      "NPM_TOKEN=[REDACTED]",
    );
  });

  // The other half of the corpus, and the half a redaction pass gets wrong:
  // an ordinary line must come back byte for byte.
  it.each([
    ["a short identifier", "container-id=abc123"],
    ["an ordinary log line", "Starting server on port 8080 in production mode"],
    ["a long file path", "/var/log/nginx/access.log"],
  ])("leaves %s untouched", (_shape, line) => {
    expect(redactSecrets(line).content).toBe(line);
  });
});

describe("capOutput", () => {
  it("returns short output unchanged", () => {
    const text = "hello world";
    expect(capOutput(text)).toBe(text);
  });

  it("caps output over 64 KB, naming how much it cut", () => {
    const big = "x".repeat(70 * 1024);
    const capped = capOutput(big);
    expect(capped).toContain("[cut: ");
    expect(capped).toContain("bytes]");
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThan(big.length);
  });

  it("preserves the head and tail of the output", () => {
    const head = "HEAD_CONTENT ";
    const tail = " TAIL_CONTENT";
    const big = head + "M".repeat(70 * 1024) + tail;
    const capped = capOutput(big);
    expect(capped).toContain("HEAD_CONTENT");
    expect(capped).toContain("TAIL_CONTENT");
  });

  it("does not split a multibyte character into a replacement char at the cut", () => {
    // Each emoji is 4 UTF-8 bytes, so an arbitrary byte cut lands mid-character;
    // a naive byte slice would decode the split halves as U+FFFD.
    const capped = capOutput("😀".repeat(40_000));
    expect(capped).toContain("bytes]");
    expect(capped).not.toContain("�");
  });
});

describe("sanitizeLines", () => {
  // A PEM key spans many lines, so per-line matching would miss every one of
  // them; the lines are sanitized as one document and re-split.
  it("redacts a private key that spans several lines", () => {
    const out = sanitizeLines([
      "starting up",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAtR4bF9mK2xQ",
      "9dLpXvN3jH8sYgTzR1cWqE5uOaP",
      "-----END RSA PRIVATE KEY-----",
      "ready",
    ]).join("\n");

    expect(out).not.toContain("MIIEowIBAAKCAQEAtR4bF9mK2xQ");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("starting up");
    expect(out).toContain("ready");
  });
});
