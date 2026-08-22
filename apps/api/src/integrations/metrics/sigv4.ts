import { AwsClient } from "aws4fetch";
import type { AmpCredential } from "@nightwarden/shared";

// aws4fetch signs a plain fetch Request directly, fitting metricsFetch's
// raw-fetch style without an AWS SDK dependency tree.

// AMP's own SigV4 service identifier, for both its query and rules APIs.
const AMP_SERVICE = "aps";

export async function signedRequest(
  credential: AmpCredential,
  url: string,
  init: RequestInit,
): Promise<Request> {
  const client = new AwsClient({
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
    ...(credential.sessionToken !== undefined && {
      sessionToken: credential.sessionToken,
    }),
    region: credential.region,
    service: AMP_SERVICE,
  });
  return client.sign(url, init);
}
