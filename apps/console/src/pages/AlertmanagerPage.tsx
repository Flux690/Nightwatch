import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunnerRecord } from "@nightwarden/shared";
import { ChevronDown, Eye, EyeOff } from "lucide-react";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { CopyableSnippet } from "@/components/layout/CopyableSnippet";
import { ICON_INLINE, ICON_UI } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

interface CredentialStatus {
  configured: boolean;
  ingestUrl: string;
  lastReceivedAt: string | null;
}

// The API's real /alerts/validate shape: an advisory fleet match per alert.
interface ValidateAlertResult {
  sourceAlertId: string;
  identityKey: string;
  advertisedOn: string[];
  exactMatch: boolean;
}

const MASKED_TOKEN = "nwi_ ••••••••";

function sampleWebhookPayload(serverName: string): unknown {
  return {
    alerts: [
      {
        status: "firing",
        labels: {
          alertname: "TestAlert",
          severity: "warning",
          container: "sample-service",
          ...(serverName && { nw_server: serverName }),
        },
        annotations: { summary: "Sample alert from the Alertmanager page" },
        startsAt: new Date().toISOString(),
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint: "alertmanager-test-webhook",
      },
    ],
  };
}

function receiverSnippet(ingestUrl: string, token: string): string {
  return [
    "receivers:",
    "  - name: nightwarden",
    "    webhook_configs:",
    `      - url: '${ingestUrl}'`,
    "        http_config:",
    "          authorization:",
    "            type: Bearer",
    `            credentials: '${token}'`,
  ].join("\n");
}

function perTargetSnippet(name: string): string {
  return [
    "scrape_configs:",
    `  - job_name: node               # each job that scrapes ${name}`,
    "    static_configs:",
    '      - targets: ["10.0.0.5:9100"]   # your existing target line',
    "        labels:",
    `          nw_server: "${name}"`,
  ].join("\n");
}

function externalLabelsSnippet(name: string): string {
  return ["global:", "  external_labels:", `    nw_server: "${name}"`].join(
    "\n",
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function AlertmanagerPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState("");
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState<
    | { ok: true; results: ValidateAlertResult[] }
    | { ok: false; error: string }
    | null
  >(null);

  const { data: status, isLoading } = useQuery<CredentialStatus>({
    queryKey: ["alertmanager-integration"],
    queryFn: () => apiFetch<CredentialStatus>("/api/integrations/alertmanager"),
  });

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
  });

  const connected = (runners ?? []).filter(
    (r) => r.online && r.hostname !== null,
  );
  const dockerServers = connected
    .filter((r) => r.manifest?.capabilities.docker === true)
    .map((r) => r.serverName ?? r.hostname ?? r.id);
  const k8sRunnerCount = connected.filter(
    (r) => r.manifest?.capabilities.kubernetes === true,
  ).length;
  const effectiveServer = selectedServer || (dockerServers[0] ?? "");

  const generate = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>("/api/integrations/alertmanager/credential", {
        method: "POST",
      }),
    onSuccess: async ({ token: minted }) => {
      const rotating = status?.configured === true;
      setToken(minted);
      setWebhookTestResult(null);
      if (rotating) {
        toast.success(
          "Credential rotated - paste the updated receiver into your Alertmanager",
        );
      }
      await queryClient.invalidateQueries({
        queryKey: ["alertmanager-integration"],
      });
    },
    onError: (err) =>
      toast.show({
        title: "Could not generate credential",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const reveal = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>(
        "/api/integrations/alertmanager/credential/reveal",
        {
          method: "POST",
        },
      ),
    onSuccess: ({ token: revealed }) => setToken(revealed),
    onError: (err) =>
      toast.show({
        title: "Could not show the token",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const testWebhook = useMutation({
    mutationFn: async (): Promise<ValidateAlertResult[]> => {
      if (token === null) throw new Error("Show the token first");
      const body = await apiFetch<{
        alerts?: ValidateAlertResult[];
        error?: string;
      }>("/api/alerts/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(sampleWebhookPayload(effectiveServer)),
      });
      if (!body.alerts) throw new Error(body.error ?? "Test webhook failed");
      return body.alerts;
    },
    onMutate: () => setWebhookTestResult(null),
    onSuccess: (results) => setWebhookTestResult({ ok: true, results }),
    onError: (err) =>
      setWebhookTestResult({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to test webhook",
      }),
  });

  const busy = generate.isPending || reveal.isPending;
  const configured = status?.configured === true;
  // Minting in this visit (setup or rotation) means the user is mid-setup: the
  // page reads as steps to finish, not as a status report on unfinished work.
  const showStatus = configured && !generate.isSuccess;

  const snippetActions = !configured ? (
    <Button size="xs" disabled={busy} onClick={() => generate.mutate()}>
      {generate.isPending && <Spinner className="size-3" />}
      Generate credential
    </Button>
  ) : token === null ? (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Show token"
      disabled={busy}
      onClick={() => reveal.mutate()}
    >
      <Eye {...ICON_UI} />
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Hide token"
      onClick={() => setToken(null)}
    >
      <EyeOff {...ICON_UI} />
    </Button>
  );

  return (
    <Page>
      <PageHeader>
        <PageTitle>Alertmanager</PageTitle>
        {showStatus && status && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden="true"
              className={
                status.lastReceivedAt !== null
                  ? "size-1.5 rounded-full bg-success"
                  : "size-1.5 rounded-full bg-muted-foreground"
              }
            />
            {status.lastReceivedAt !== null
              ? `Receiving - last alert ${relativeTime(status.lastReceivedAt)}`
              : "Waiting for first alert"}
          </div>
        )}
      </PageHeader>

      <div className="flex flex-col gap-8">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Forward alerts from the Alertmanager you already run. One credential
          covers the whole fleet.
        </p>

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {status && (
          <>
            <section className="flex flex-col gap-2">
              <p className="text-sm font-semibold">
                1. Paste this receiver into your alertmanager.yml
              </p>
              <CopyableSnippet
                label="Copy Alertmanager receiver"
                text={receiverSnippet(status.ingestUrl, token ?? MASKED_TOKEN)}
                actions={snippetActions}
                copyable={token !== null}
              />
            </section>

            {configured && (
              <section className="flex flex-col gap-2">
                <p className="text-sm font-semibold">
                  2. Reload Alertmanager, then prove the pipe
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={token === null || testWebhook.isPending}
                    onClick={() => testWebhook.mutate()}
                  >
                    {testWebhook.isPending && <Spinner className="size-3" />}
                    Test webhook
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setConfirmRotate(true)}
                  >
                    Rotate credential
                  </Button>
                </div>
                {token === null && (
                  <p className="text-sm text-muted-foreground">
                    Show the token to enable the test.
                  </p>
                )}

                {webhookTestResult?.ok === true &&
                  webhookTestResult.results.map((result) => (
                    <Alert key={result.sourceAlertId}>
                      <AlertTitle>
                        {result.exactMatch
                          ? "Resolved to one server"
                          : "No exact match"}
                      </AlertTitle>
                      <AlertDescription>
                        <span className="block">{result.identityKey}</span>
                        <span className="block">
                          {result.advertisedOn.length > 0
                            ? `Advertised on ${result.advertisedOn.join(", ")}.`
                            : "No runner advertises this identity - the agent triages it from the fleet map."}
                        </span>
                      </AlertDescription>
                    </Alert>
                  ))}
                {webhookTestResult?.ok === false && (
                  <Alert variant="destructive">
                    <AlertTitle>Test webhook failed</AlertTitle>
                    <AlertDescription>
                      {webhookTestResult.error}
                    </AlertDescription>
                  </Alert>
                )}
              </section>
            )}

            {configured && dockerServers.length === 1 && (
              <p className="max-w-3xl text-sm text-muted-foreground">
                One server - alerts resolve to it automatically. When you add a
                second, come back here to label which server each alert is
                about.
              </p>
            )}

            {configured && dockerServers.length >= 2 && (
              <section className="flex flex-col gap-2">
                <p className="text-sm font-semibold">
                  Make your alerts say which server they&apos;re about
                </p>
                <p className="max-w-3xl text-sm text-muted-foreground">
                  With {dockerServers.length} servers, the same service can run
                  in two places. Add an nw_server label per scrape target in
                  your Prometheus so every alert carries its server.
                </p>
                <Field className="max-w-80">
                  <FieldLabel htmlFor="server-select">Server</FieldLabel>
                  <FieldDescription>
                    Names come from your connected runners.
                  </FieldDescription>
                  <NativeSelect
                    id="server-select"
                    value={effectiveServer}
                    onChange={(e) => setSelectedServer(e.currentTarget.value)}
                  >
                    {dockerServers.map((name) => (
                      <NativeSelectOption key={name} value={name}>
                        {name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <CopyableSnippet
                  label="Copy Prometheus labels"
                  text={perTargetSnippet(effectiveServer)}
                />
                <Collapsible>
                  <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    <ChevronDown {...ICON_INLINE} />
                    This Prometheus only monitors {effectiveServer}? Set it once
                    instead
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="pt-2">
                      <CopyableSnippet
                        label="Copy external_labels"
                        text={externalLabelsSnippet(effectiveServer)}
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            )}

            {configured && k8sRunnerCount >= 2 && (
              <section className="flex flex-col gap-2">
                <p className="text-sm font-semibold">
                  Multiple Kubernetes clusters
                </p>
                <p className="max-w-3xl text-sm text-muted-foreground">
                  Give each cluster&apos;s alerts a cluster label (in that
                  cluster&apos;s Prometheus external_labels) and set
                  NIGHTWARDEN_CLUSTER_NAME to the same value on its runner.
                </p>
                <CopyableSnippet
                  label="Copy cluster external_labels"
                  text={[
                    "global:",
                    "  external_labels:",
                    '    cluster: "prod-cluster"',
                  ].join("\n")}
                />
              </section>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate credential?"
        description="The current credential stops working immediately, and your Alertmanager stops delivering until you paste the updated receiver."
        confirmLabel="Rotate"
        destructive
        onConfirm={() => generate.mutate()}
      />
    </Page>
  );
}
