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
function sampleWebhookPayload(provider: Provider, serverName: string): unknown {
  const labels =
    provider === "docker"
      ? {
          alertname: "TestAlert",
          severity: "warning",
          container: "sample-service",
          server: serverName,
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

function CopyableSnippet({
  lines,
  label,
}: {
  lines: string[];
  label: string;
}): React.JSX.Element {
  const text = lines.join("\n");
  return (
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
        {text}
      </Code>
      <ActionIcon
        variant="default"
        size="lg"
        aria-label={label}
        onClick={() => void navigator.clipboard.writeText(text)}
      >
        ⧉
      </ActionIcon>
    </Group>
  );
}

// Bring-your-own monitoring panel for the Install step. The fleet ingest credential
// is fetched by the wizard and passed in, so the two config snippets - the Prometheus
// server label and the Alertmanager webhook - are shown inline, no reveal step.
export function WizardMonitoringStep({
  provider,
  trimmedServerName,
  ingestToken,
  ingestUrl,
}: {
  provider: Provider;
  trimmedServerName: string;
  ingestToken: string;
  ingestUrl: string;
}): React.JSX.Element {
  const [webhookTestResult, setWebhookTestResult] = useState<
    | { ok: true; results: ValidateAlertResult[] }
    | { ok: false; error: string }
    | null
  >(null);

  const testWebhook = useMutation({
    mutationFn: async (): Promise<ValidateAlertResult[]> => {
      const body = await apiFetch<{
        alerts?: ValidateAlertResult[];
        error?: string;
      }>("/api/alerts/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ingestToken}`,
        },
        body: JSON.stringify(sampleWebhookPayload(provider, trimmedServerName)),
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
          Wire your own Prometheus and Alertmanager to Nightwatch. Every server
          shares this one ingest credential; the server label tells Nightwatch
          which server an alert is about.
        </Text>

        {provider === "docker" && trimmedServerName && (
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              1. In your Prometheus &mdash; stamp the server label
            </Text>
            <CopyableSnippet
              label="Copy Prometheus config"
              lines={[
                "global:",
                "  external_labels:",
                `    server: "${trimmedServerName}"`,
              ]}
            />
          </Stack>
        )}

        <Stack gap="xs">
          <Text size="sm" fw={600}>
            2. In your Alertmanager &mdash; forward alerts to Nightwatch
          </Text>

          <Text size="xs" c="dimmed">
            Webhook URL
          </Text>
          <CopyableSnippet label="Copy webhook URL" lines={[ingestUrl]} />

          <Text size="xs" c="dimmed">
            Auth (Bearer token)
          </Text>
          <CopyableSnippet label="Copy ingest token" lines={[ingestToken]} />

          <Text size="xs" c="dimmed">
            Or paste this receiver directly:
          </Text>
          <CopyableSnippet
            label="Copy Alertmanager receiver"
            lines={[
              "receivers:",
              "  - name: nightwatch",
              "    webhook_configs:",
              `      - url: '${ingestUrl}'`,
              "        http_config:",
              "          authorization:",
              "            type: Bearer",
              `            credentials: '${ingestToken}'`,
            ]}
          />
        </Stack>

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
      </Stack>
    </Alert>
  );
}
