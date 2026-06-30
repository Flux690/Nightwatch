import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert } from "../ui/Alert.js";
import { Button } from "../ui/Button.js";
import { Code } from "../ui/Code.js";
import { Group } from "../ui/Group.js";
import { IconButton } from "../ui/IconButton.js";
import { Stack } from "../ui/Stack.js";
import { Text } from "../ui/Text.js";
import { apiFetch } from "../api/client.js";
import type { Provider } from "./AddServerWizard.js";

interface ValidateAlertResult {
  sourceAlertId: string;
  identityKey: string;
  resolution:
    | { status: "resolved"; runnerId: string; hostname: string }
    | { status: "rejected"; reason: string };
}

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
    <Group className="gap-2 items-start flex-nowrap">
      <Code
        block
        style={{
          flex: 1,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {text}
      </Code>
      <IconButton
        aria-label={label}
        onClick={() => void navigator.clipboard.writeText(text)}
      >
        ⧉
      </IconButton>
    </Group>
  );
}

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
    <Alert intent="info" title="Bring-your-own monitoring">
      <Stack className="gap-4">
        <Text className="text-sm">
          Wire your own Prometheus and Alertmanager to Nightwatch. Every server
          shares this one ingest credential; the server label tells Nightwatch
          which server an alert is about.
        </Text>

        {provider === "docker" && trimmedServerName && (
          <Stack className="gap-2">
            <Text className="text-sm font-semibold">
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

        <Stack className="gap-2">
          <Text className="text-sm font-semibold">
            2. In your Alertmanager &mdash; forward alerts to Nightwatch
          </Text>

          <Text className="text-xs text-ink-muted">Webhook URL</Text>
          <CopyableSnippet label="Copy webhook URL" lines={[ingestUrl]} />

          <Text className="text-xs text-ink-muted">Auth (Bearer token)</Text>
          <CopyableSnippet label="Copy ingest token" lines={[ingestToken]} />

          <Text className="text-xs text-ink-muted">
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

        <Stack className="gap-2">
          <Button
            size="xs"
            variant="secondary"
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
                intent={
                  result.resolution.status === "resolved" ? "success" : "error"
                }
                title={
                  result.resolution.status === "resolved"
                    ? "Resolved"
                    : "Rejected"
                }
              >
                <Text className="text-sm">{result.identityKey}</Text>
                {result.resolution.status === "resolved" ? (
                  <Text className="text-sm">
                    Would route to {result.resolution.hostname}.
                  </Text>
                ) : (
                  <Text className="text-sm">{result.resolution.reason}</Text>
                )}
              </Alert>
            ))}
          {webhookTestResult?.ok === false && (
            <Alert intent="error" title="Test webhook failed">
              {webhookTestResult.error}
            </Alert>
          )}
        </Stack>
      </Stack>
    </Alert>
  );
}
