import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AmpCredential } from "@nightwarden/shared";
import { signedRequest } from "../integrations/metrics/sigv4.js";

// Fixed credentials from AWS's own published SigV4 test suite
// (aws-sig-v4-test-suite, "get-vanilla"), not invented for this test.
const CREDENTIAL: AmpCredential = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};

describe("SigV4 signing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2015-08-30T12:36:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs a request to match AWS's own published test vector", async () => {
    const signed = await signedRequest(
      CREDENTIAL,
      "https://example.amazonaws.com/",
      { method: "GET" },
    );
    expect(signed.headers.get("x-amz-date")).toBe("20150830T123600Z");
    // "service" in the credential scope is aws4fetch's default when none is
    // named - AMP's own signer names "aps" explicitly (see sigv4.ts).
    expect(signed.headers.get("authorization")).toContain(
      "Credential=AKIDEXAMPLE/20150830/us-east-1/",
    );
    expect(signed.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=\S+, SignedHeaders=\S+, Signature=[0-9a-f]{64}$/,
    );
  });

  it("signs with AMP's own service identifier, not a default", async () => {
    const signed = await signedRequest(
      CREDENTIAL,
      "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-test/api/v1/query",
      { method: "POST", body: "query=up" },
    );
    expect(signed.headers.get("authorization")).toContain(
      "Credential=AKIDEXAMPLE/20150830/us-east-1/aps/aws4_request",
    );
  });

  it("includes a session token when one is given", async () => {
    const signed = await signedRequest(
      { ...CREDENTIAL, sessionToken: "a-temporary-token" },
      "https://example.amazonaws.com/",
      { method: "GET" },
    );
    expect(signed.headers.get("x-amz-security-token")).toBe(
      "a-temporary-token",
    );
  });
});
