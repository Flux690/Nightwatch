import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CopyableSnippet } from "@/components/layout/CopyableSnippet";
import { apiFetch } from "@/api/client";
import type { Provider } from "@/pages/AddServerPage";

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
    <section>
      <p className="mb-3 text-sm font-semibold">Bring-your-own monitoring</p>
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          Wire your own Prometheus and Alertmanager to Nightwatch. Every server
          shares this one ingest credential; the server label tells Nightwatch
          which server an alert is about.
        </p>

        {provider === "docker" && trimmedServerName && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">
              1. In your Prometheus &mdash; stamp the server label
            </p>
            <CopyableSnippet
              label="Copy Prometheus config"
              text={[
                "global:",
                "  external_labels:",
                `    server: "${trimmedServerName}"`,
              ].join("\n")}
            />
          </div>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">
            2. In your Alertmanager &mdash; forward alerts to Nightwatch
          </p>

          <p className="text-xs text-muted-foreground">Webhook URL</p>
          <CopyableSnippet label="Copy webhook URL" text={ingestUrl} />

          <p className="text-xs text-muted-foreground">Auth (Bearer token)</p>
          <CopyableSnippet label="Copy ingest token" text={ingestToken} />

          <p className="text-xs text-muted-foreground">
            Or paste this receiver directly:
          </p>
          <CopyableSnippet
            label="Copy Alertmanager receiver"
            text={[
              "receivers:",
              "  - name: nightwatch",
              "    webhook_configs:",
              `      - url: '${ingestUrl}'`,
              "        http_config:",
              "          authorization:",
              "            type: Bearer",
              `            credentials: '${ingestToken}'`,
            ].join("\n")}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Button
            size="xs"
            variant="secondary"
            className="self-start"
            disabled={testWebhook.isPending}
            onClick={() => testWebhook.mutate()}
          >
            {testWebhook.isPending && <Spinner className="size-3" />}
            Test webhook
          </Button>

          {webhookTestResult?.ok === true &&
            webhookTestResult.results.map((result) => (
              <Alert
                key={result.sourceAlertId}
                variant={
                  result.resolution.status === "resolved"
                    ? undefined
                    : "destructive"
                }
              >
                <AlertTitle>
                  {result.resolution.status === "resolved"
                    ? "Resolved"
                    : "Rejected"}
                </AlertTitle>
                <AlertDescription>
                  <span className="block">{result.identityKey}</span>
                  {result.resolution.status === "resolved" ? (
                    <span className="block">
                      Would route to {result.resolution.hostname}.
                    </span>
                  ) : (
                    <span className="block">{result.resolution.reason}</span>
                  )}
                </AlertDescription>
              </Alert>
            ))}
          {webhookTestResult?.ok === false && (
            <Alert variant="destructive">
              <AlertTitle>Test webhook failed</AlertTitle>
              <AlertDescription>{webhookTestResult.error}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </section>
  );
}
