import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Radio,
  Stack,
  Stepper,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { RunnerRecord } from "@nightwatch/shared";

export type Provider = "docker" | "kubernetes";

interface MintedToken {
  id: string;
  token: string;
}

interface ValidateAlertResult {
  sourceAlertId: string;
  identityKey: string;
  resolution:
    | { status: "resolved"; runnerId: string; hostname: string }
    | { status: "rejected"; reason: string };
}

const RUNNER_POLL_MS = 3000;

function validateServerName(name: string): string | null {
  if (name.trim().length === 0) return "Server name is required";
  if (name.includes("/")) return "Server name must not contain '/'";
  return null;
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

export function AddServerWizard({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [serverName, setServerName] = useState("");
  const [serverNameTouched, setServerNameTouched] = useState(false);
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [installText, setInstallText] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [generatingIngest, setGeneratingIngest] = useState(false);
  const [revealingIngest, setRevealingIngest] = useState(false);
  const [ingestToken, setIngestToken] = useState<string | null>(null);
  // True when the shown token was just minted (old one now invalid) vs revealed.
  const [ingestTokenFresh, setIngestTokenFresh] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState<
    | { ok: true; results: ValidateAlertResult[] }
    | { ok: false; error: string }
    | null
  >(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<
    { ok: true; hostname: string } | { ok: false; error: string } | null
  >(null);

  const serverNameError = serverName.includes("/")
    ? "Server name must not contain '/'"
    : serverNameTouched && serverName.trim().length === 0
      ? "Server name is required"
      : null;
  const canContinueFromProvider =
    provider !== null && validateServerName(serverName) === null;

  const { data: ingestCredential } = useQuery<{ configured: boolean }>({
    queryKey: ["wizard-ingest-credential"],
    queryFn: () =>
      fetch("/api/ingest-credential").then((r) => {
        if (!r.ok) throw new Error(`ingest-credential ${r.status}`);
        return r.json() as Promise<{ configured: boolean }>;
      }),
    enabled: step === 2,
  });

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["wizard-runners"],
    queryFn: () =>
      fetch("/api/runners").then((r) => {
        if (!r.ok) throw new Error(`runners ${r.status}`);
        return r.json() as Promise<RunnerRecord[]>;
      }),
    enabled: step === 1 && mintedToken !== null,
    refetchInterval: step === 1 ? RUNNER_POLL_MS : false,
  });

  // hostname (and the manifest-derived id behind it) lands together with the
  // runner's first manifest, slightly after the socket itself goes online -
  // require it so the id used to target the verify alert is always the real
  // fleet runnerId, never the token's placeholder uuid.
  const connectedRunner = runners?.find(
    (r) => r.token === mintedToken?.id && r.online && r.hostname !== null,
  );

  function handleClose(): void {
    setStep(0);
    setProvider(null);
    setServerName("");
    setServerNameTouched(false);
    setMinting(false);
    setMintedToken(null);
    setInstallText(null);
    setInstallError(null);
    setGeneratingIngest(false);
    setRevealingIngest(false);
    setIngestToken(null);
    setIngestTokenFresh(false);
    setTestingWebhook(false);
    setWebhookTestResult(null);
    setVerifying(false);
    setVerifyResult(null);
    onClose();
  }

  async function handleChooseProvider(): Promise<void> {
    if (!canContinueFromProvider) return;
    setStep(1);
    setMinting(true);
    setInstallError(null);
    try {
      const tokenRes = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverName: serverName.trim() }),
      });
      if (!tokenRes.ok) {
        if (tokenRes.status === 409) {
          const body = (await tokenRes.json()) as { error?: string };
          setInstallError(
            body.error ?? "A runner with that server name already exists",
          );
          setStep(0);
          return;
        }
        throw new Error(`tokens ${tokenRes.status}`);
      }
      const minted = (await tokenRes.json()) as MintedToken;
      setMintedToken(minted);

      const installUrl =
        provider === "docker" ? "/api/connect.sh" : "/api/manifest.yaml";
      const installRes = await fetch(installUrl, {
        headers: { Authorization: `Bearer ${minted.token}` },
      });
      if (!installRes.ok) throw new Error(`${installUrl} ${installRes.status}`);
      setInstallText(await installRes.text());
    } catch (err) {
      setInstallError(
        err instanceof Error ? err.message : "Failed to prepare install",
      );
    } finally {
      setMinting(false);
    }
  }

  function copyInstallText(): void {
    if (installText !== null) void navigator.clipboard.writeText(installText);
  }

  const [generateError, setGenerateError] = useState<string | null>(null);

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
    if (!token || !provider) return;
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

  async function handleSendTestAlert(): Promise<void> {
    if (!connectedRunner) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/alerts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runnerId: connectedRunner.id }),
      });
      const body = (await res.json()) as
        | { ok: true; hostname: string }
        | { error: string };
      if (!res.ok || !("ok" in body)) {
        setVerifyResult({
          ok: false,
          error: "error" in body ? body.error : `alerts/test ${res.status}`,
        });
        return;
      }
      setVerifyResult({ ok: true, hostname: body.hostname });
    } catch (err) {
      setVerifyResult({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to send test alert",
      });
    } finally {
      setVerifying(false);
    }
  }

  const trimmedServerName = serverName.trim();

  return (
    <Modal opened={opened} onClose={handleClose} title="Add a server" size="lg">
      <Stepper active={step} onStepClick={setStep} allowNextStepsSelect={false}>
        <Stepper.Step label="Provider">
          <Stack gap="md" mt="md">
            <Radio.Group
              label="Which substrate is this server running?"
              value={provider ?? ""}
              onChange={(v) => setProvider(v as Provider)}
            >
              <Group mt="xs">
                <Radio value="docker" label="Docker" />
                <Radio value="kubernetes" label="Kubernetes" />
              </Group>
            </Radio.Group>

            <TextInput
              label="Server name"
              description="A unique name for this server in your fleet. Immutable once installed."
              placeholder="e.g. prod-web-01"
              value={serverName}
              onChange={(e) => setServerName(e.currentTarget.value)}
              onBlur={() => setServerNameTouched(true)}
              error={serverNameError}
            />

            {installError !== null && step === 0 && (
              <Text size="sm" c="red">
                {installError}
              </Text>
            )}

            <Group justify="flex-end">
              <Button
                disabled={!canContinueFromProvider}
                onClick={() => void handleChooseProvider()}
              >
                Continue
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="Install">
          <Stack gap="md" mt="md">
            {minting && (
              <Group gap="xs">
                <Loader size="xs" />
                <Text size="sm" c="dimmed">
                  Generating a runner token...
                </Text>
              </Group>
            )}

            {installError !== null && step === 1 && (
              <Text size="sm" c="red">
                {installError}
              </Text>
            )}

            {installText !== null && (
              <Stack gap="xs">
                <Text size="sm">
                  Run this on the target server to install the runner:
                </Text>
                <Group gap="xs" align="flex-start" wrap="nowrap">
                  <Code
                    block
                    style={{
                      flex: 1,
                      fontFamily: "var(--nw-mono)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 240,
                      overflow: "auto",
                    }}
                  >
                    {installText}
                  </Code>
                  <ActionIcon
                    variant="default"
                    size="lg"
                    aria-label="Copy install command"
                    onClick={copyInstallText}
                  >
                    ⧉
                  </ActionIcon>
                </Group>

                <Group gap="xs" align="center">
                  {connectedRunner ? (
                    <Badge color="green" variant="light">
                      Runner connected
                    </Badge>
                  ) : (
                    <Group gap="xs">
                      <Loader size="xs" />
                      <Text size="sm" c="dimmed">
                        Waiting for the runner to connect...
                      </Text>
                    </Group>
                  )}
                </Group>
              </Stack>
            )}

            <Group justify="flex-end">
              <Button disabled={!connectedRunner} onClick={() => setStep(2)}>
                Continue
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="Monitoring">
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

            {(() => {
              const displayToken = ingestToken;
              if (displayToken === null) return null;
              return (
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
                        {displayToken}
                      </Code>
                      <ActionIcon
                        variant="default"
                        size="lg"
                        aria-label="Copy ingest credential"
                        onClick={() =>
                          void navigator.clipboard.writeText(displayToken)
                        }
                      >
                        ⧉
                      </ActionIcon>
                    </Group>

                    <Text size="sm">
                      Point your Alertmanager (bundled or your own) at this
                      fleet-wide webhook:
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
                        `            credentials: '${displayToken}'`,
                      ].join("\n")}
                    </Code>
                  </Stack>
                </Alert>
              );
            })()}

            {trimmedServerName && (
              <Alert color="blue" title="Bring-your-own monitoring">
                <Stack gap="xs">
                  <Text size="sm">
                    If you use your own Prometheus, add this to its global
                    configuration so alerts carry the server label that routes
                    them to this runner:
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

            {(() => {
              const displayToken = ingestToken;
              if (displayToken === null) return null;
              return (
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
                          result.resolution.status === "resolved"
                            ? "green"
                            : "red"
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
              );
            })()}

            <Group justify="flex-end">
              <Button onClick={() => setStep(3)}>Continue</Button>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="Verify">
          <Stack gap="md" mt="md">
            <Text size="sm">
              Send a synthetic alert through the full pipeline to confirm it
              reaches this server.
            </Text>

            <Button
              style={{ alignSelf: "flex-start" }}
              loading={verifying}
              disabled={!connectedRunner}
              onClick={() => void handleSendTestAlert()}
            >
              Send test alert
            </Button>

            {verifyResult?.ok === true && (
              <Alert color="green" title="Pipeline verified">
                Alert received and routed to {verifyResult.hostname}.
              </Alert>
            )}
            {verifyResult?.ok === false && (
              <Alert color="red" title="Verification failed">
                {verifyResult.error}
              </Alert>
            )}

            <Group justify="flex-end">
              <Button variant="default" onClick={handleClose}>
                Done
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
      </Stepper>
    </Modal>
  );
}
