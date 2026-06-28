import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Code,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "../api/client.js";
import type { Provider } from "./AddServerWizard.js";

interface ValidateAlertResult {
  sourceAlertId: string;
  identityKey: string;
  resolution:
    | { status: "resolved"; runnerId: string; hostname: string }
    | { status: "rejected"; reason: string };
}

// A synthetic alert sent through /alerts/validate to confirm the credential
// and the basic webhook shape work end-to-end before the operator wires up
// their real monitoring labels.
function sampleWebhookPayload(provider: Provider): unknown {
  const labels =
    provider === "docker"
      ? {
          alertname: "TestAlert",
          severity: "warning",
          container: "sample-service",
        }
      : {
          alertname: "TestAlert",
          severity: "warning",
          namespace: "default",
          deployment: "sample-service",
        };
  return {
    alerts: [
      {
        status: "firing",
        labels,
        annotations: { summary: "Sample alert from the add-server wizard" },
        startsAt: new Date().toISOString(),
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint: "wizard-test-webhook",
      },
    ],
  };
}

// Bring-your-own monitoring panel for the Install step. The fleet ingest
// credential already exists (the install-script fetch establishes it), so this
// only reveals it on demand; one credential is shared fleet-wide.
export function WizardMonitoringStep({
  provider,
  trimmedServerName,
}: {
  provider: Provider;
  trimmedServerName: string;
}): React.JSX.Element {
  const [ingestToken, setIngestToken] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [webhookTestResult, setWebhookTestResult] = useState<
    | { ok: true; results: ValidateAlertResult[] }
    | { ok: false; error: string }
    | null
  >(null);

  const revealCredential = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>("/api/ingest-credential/reveal", {
        method: "POST",
      }),
    onMutate: () => setRevealError(null),
    onSuccess: ({ token }) => setIngestToken(token),
    onError: (err) =>
      setRevealError(
        err instanceof Error ? err.message : "Failed to reveal credential",
      ),
  });

  const testWebhook = useMutation({
    mutationFn: async (): Promise<ValidateAlertResult[]> => {
      const body = await apiFetch<{
        alerts?: ValidateAlertResult[];
        error?: string;
      }>("/api/alerts/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ingestToken ?? ""}`,
        },
        body: JSON.stringify(sampleWebhookPayload(provider)),
      });
      // A 2xx with no alerts still means the test didn't resolve; surface it.
      if (!body.alerts) throw new Error(body.error ?? "Test webhook failed");
      return body.alerts;
    },
    onSuccess: (results) => setWebhookTestResult({ ok: true, results }),
    onError: (err) =>
      setWebhookTestResult({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to test webhook",
      }),
  });

  return (
    <Alert color="blue" title="Bring-your-own monitoring">
      <Stack gap="md">
        <Text size="sm">
          Point your existing Alertmanager at Nightwatch&apos;s fleet-wide
          webhook. Every server shares this one ingest credential; alerts route
          by the server label.
        </Text>

        {ingestToken === null ? (
          <Button
            size="xs"
            variant="default"
            style={{ alignSelf: "flex-start" }}
            loading={revealCredential.isPending}
            onClick={() => revealCredential.mutate()}
          >
            Reveal ingest credential
          </Button>
        ) : (
          <Stack gap="sm">
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <Code
                block
                style={{
                  flex: 1,
                  fontFamily: "var(--nw-mono)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {ingestToken}
              </Code>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Copy ingest credential"
                onClick={() => void navigator.clipboard.writeText(ingestToken)}
              >
                ⧉
              </ActionIcon>
            </Group>

            <Text size="sm">
              Add this receiver to your Alertmanager configuration:
            </Text>
            <Code
              block
              style={{ whiteSpace: "pre-wrap", fontFamily: "var(--nw-mono)" }}
            >
              {[
                "receivers:",
                "  - name: nightwatch",
                "    webhook_configs:",
                `      - url: '${window.location.origin}/alerts/ingest'`,
                "        http_config:",
                "          authorization:",
                "            type: Bearer",
                `            credentials: '${ingestToken}'`,
              ].join("\n")}
            </Code>
          </Stack>
        )}

        {revealError !== null && (
          <Text size="sm" c="red">
            {revealError}
          </Text>
        )}

        {trimmedServerName && (
          <Stack gap="xs">
            <Text size="sm">
              Stamp the server label on your Prometheus so alerts route to this
              runner:
            </Text>
            <Code
              block
              style={{ whiteSpace: "pre-wrap", fontFamily: "var(--nw-mono)" }}
            >
              {[
                "global:",
                "  external_labels:",
                `    instance: "${trimmedServerName}"`,
              ].join("\n")}
            </Code>
          </Stack>
        )}

        {ingestToken !== null && (
          <Stack gap="xs">
            <Button
              size="xs"
              variant="default"
              style={{ alignSelf: "flex-start" }}
              loading={testWebhook.isPending}
              onClick={() => testWebhook.mutate()}
            >
              Test webhook
            </Button>

            {webhookTestResult?.ok === true &&
              webhookTestResult.results.map((result) => (
                <Alert
                  key={result.sourceAlertId}
                  color={
                    result.resolution.status === "resolved" ? "green" : "red"
                  }
                  title={
                    result.resolution.status === "resolved"
                      ? "Resolved"
                      : "Rejected"
                  }
                >
                  <Text size="sm">{result.identityKey}</Text>
                  {result.resolution.status === "resolved" ? (
                    <Text size="sm">
                      Would route to {result.resolution.hostname}.
                    </Text>
                  ) : (
                    <Text size="sm">{result.resolution.reason}</Text>
                  )}
                </Alert>
              ))}
            {webhookTestResult?.ok === false && (
              <Alert color="red" title="Test webhook failed">
                {webhookTestResult.error}
              </Alert>
            )}
          </Stack>
        )}
      </Stack>
    </Alert>
  );
}
