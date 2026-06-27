import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
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

// The wizard's Monitoring step: mint or reveal the fleet ingest credential, show
// the Alertmanager wiring, and dry-run a webhook. All of its state is local to
// this step, so it owns it rather than threading it through the wizard.
export function WizardMonitoringStep({
  provider,
  trimmedServerName,
  onContinue,
}: {
  provider: Provider;
  trimmedServerName: string;
  onContinue: () => void;
}): React.JSX.Element {
  const { data: ingestCredential } = useQuery<{ configured: boolean }>({
    queryKey: ["wizard-ingest-credential"],
    queryFn: () => apiFetch<{ configured: boolean }>("/api/ingest-credential"),
  });

  const [generatingIngest, setGeneratingIngest] = useState(false);
  const [revealingIngest, setRevealingIngest] = useState(false);
  const [ingestToken, setIngestToken] = useState<string | null>(null);
  // True when the shown token was just minted (old one now invalid) vs revealed.
  const [ingestTokenFresh, setIngestTokenFresh] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState<
    | { ok: true; results: ValidateAlertResult[] }
    | { ok: false; error: string }
    | null
  >(null);

  async function handleGenerateIngestCredential(): Promise<void> {
    setGeneratingIngest(true);
    setGenerateError(null);
    try {
      const res = await fetch("/api/ingest-credential", { method: "POST" });
      if (!res.ok) throw new Error(`ingest-credential ${res.status}`);
      const { token } = (await res.json()) as { token: string };
      setIngestToken(token);
      setIngestTokenFresh(true);
    } catch (err) {
      setGenerateError(
        err instanceof Error ? err.message : "Failed to generate credential",
      );
    } finally {
      setGeneratingIngest(false);
    }
  }

  async function handleRevealIngestCredential(): Promise<void> {
    setRevealingIngest(true);
    setGenerateError(null);
    try {
      const res = await fetch("/api/ingest-credential/reveal", {
        method: "POST",
      });
      if (!res.ok) throw new Error(`reveal ${res.status}`);
      const { token } = (await res.json()) as { token: string };
      setIngestToken(token);
      setIngestTokenFresh(false);
    } catch (err) {
      setGenerateError(
        err instanceof Error ? err.message : "Failed to reveal credential",
      );
    } finally {
      setRevealingIngest(false);
    }
  }

  async function handleTestWebhook(): Promise<void> {
    const token = ingestToken;
    if (!token) return;
    setTestingWebhook(true);
    setWebhookTestResult(null);
    try {
      const res = await fetch("/api/alerts/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(sampleWebhookPayload(provider)),
      });
      const body = (await res.json()) as
        | { alerts: ValidateAlertResult[] }
        | { error: string };
      if (!res.ok || !("alerts" in body)) {
        setWebhookTestResult({
          ok: false,
          error: "error" in body ? body.error : `alerts/validate ${res.status}`,
        });
        return;
      }
      setWebhookTestResult({ ok: true, results: body.alerts });
    } catch (err) {
      setWebhookTestResult({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to test webhook",
      });
    } finally {
      setTestingWebhook(false);
    }
  }

  return (
    <Stack gap="md" mt="md">
      <Group gap="xs" align="center">
        <Text size="sm" fw={500}>
          Ingest credential
        </Text>
        <Badge
          color={ingestCredential?.configured ? "green" : "gray"}
          variant="light"
        >
          {ingestCredential?.configured ? "Configured" : "Not configured"}
        </Badge>
      </Group>

      <Group gap="xs">
        {!ingestCredential?.configured ? (
          <Button
            size="xs"
            variant="default"
            loading={generatingIngest}
            onClick={() => void handleGenerateIngestCredential()}
          >
            Generate credential
          </Button>
        ) : (
          ingestToken === null && (
            <Button
              size="xs"
              variant="default"
              loading={revealingIngest}
              onClick={() => void handleRevealIngestCredential()}
            >
              Reveal credential
            </Button>
          )
        )}
      </Group>

      {generateError !== null && (
        <Text size="sm" c="red">
          {generateError}
        </Text>
      )}

      {ingestToken !== null && (
        <Alert
          color={ingestTokenFresh ? "yellow" : "blue"}
          title={
            ingestTokenFresh
              ? "New credential generated"
              : "Fleet ingest credential"
          }
        >
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
              Point your Alertmanager (bundled or your own) at this fleet-wide
              webhook:
            </Text>
            <Code
              block
              style={{
                whiteSpace: "pre-wrap",
                fontFamily: "var(--nw-mono)",
              }}
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
        </Alert>
      )}

      {trimmedServerName && (
        <Alert color="blue" title="Bring-your-own monitoring">
          <Stack gap="xs">
            <Text size="sm">
              If you use your own Prometheus, add this to its global
              configuration so alerts carry the server label that routes them to
              this runner:
            </Text>
            <Code
              block
              style={{
                whiteSpace: "pre-wrap",
                fontFamily: "var(--nw-mono)",
              }}
            >
              {[
                "global:",
                "  external_labels:",
                `    instance: "${trimmedServerName}"`,
              ].join("\n")}
            </Code>
          </Stack>
        </Alert>
      )}

      {ingestToken !== null && (
        <Stack gap="xs">
          <Button
            size="xs"
            variant="default"
            style={{ alignSelf: "flex-start" }}
            loading={testingWebhook}
            onClick={() => void handleTestWebhook()}
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

      <Group justify="flex-end">
        <Button onClick={onContinue}>Continue</Button>
      </Group>
    </Stack>
  );
}
