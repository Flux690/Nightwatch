import { useEffect, useState } from "react";
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
import { useMutation, useQuery } from "@tanstack/react-query";
import type { RunnerRecord } from "@nightwatch/shared";
import { ApiError, apiFetch } from "../api/client.js";
import { WizardMonitoringStep } from "./WizardMonitoringStep.js";

export type Provider = "docker" | "kubernetes";
type Monitoring = "bundled" | "byo";

interface MintedToken {
  id: string;
  token: string;
}

const RUNNER_POLL_MS = 3000;

function validateServerName(name: string): string | null {
  if (name.trim().length === 0) return "Server name is required";
  if (name.includes("/")) return "Server name must not contain '/'";
  return null;
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
  const [monitoring, setMonitoring] = useState<Monitoring | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [installText, setInstallText] = useState<string | null>(null);
  const [ingestToken, setIngestToken] = useState<string | null>(null);
  const [ingestUrl, setIngestUrl] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // Latches once the runner first connects: closing before this rolls the token
  // back; closing after keeps the now-real server.
  const [committed, setCommitted] = useState(false);
  const [verifyResult, setVerifyResult] = useState<
    { ok: true; hostname: string } | { ok: false; error: string } | null
  >(null);

  const serverNameError = serverName.includes("/")
    ? "Server name must not contain '/'"
    : serverNameTouched && serverName.trim().length === 0
      ? "Server name is required"
      : null;
  const canContinueFromServer =
    provider !== null &&
    monitoring !== null &&
    validateServerName(serverName) === null;

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["wizard-runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
    enabled: step === 1 && mintedToken !== null,
    refetchInterval: step === 1 ? RUNNER_POLL_MS : false,
  });

  // Require hostname: confirms the runner has connected and is genuinely online.
  const connectedRunner = runners?.find(
    (r) => r.token === mintedToken?.id && r.online && r.hostname !== null,
  );

  useEffect(() => {
    if (connectedRunner) setCommitted(true);
  }, [connectedRunner]);

  function handleClose(): void {
    // Closing before a runner ever connected means the server was abandoned: roll
    // the token back so its name is freed and no dead credential lingers. Once a
    // runner has connected the server is real and is kept.
    if (mintedToken !== null && !committed) {
      void apiFetch<void>(`/api/tokens/${mintedToken.id}`, {
        method: "DELETE",
      }).catch(() => {});
    }
    setStep(0);
    setProvider(null);
    setServerName("");
    setServerNameTouched(false);
    setMonitoring(null);
    setMinting(false);
    setMintedToken(null);
    setInstallText(null);
    setIngestToken(null);
    setIngestUrl(null);
    setInstallError(null);
    setCommitted(false);
    setVerifyResult(null);
    onClose();
  }

  async function handleStartInstall(): Promise<void> {
    if (!canContinueFromServer) return;
    setStep(1);
    setMinting(true);
    setInstallError(null);
    try {
      const minted = await apiFetch<MintedToken>("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverName: serverName.trim() }),
      });
      setMintedToken(minted);

      // Fetch the install command and (for BYO) the fleet ingest credential
      // together, so both are presented at once rather than one gating the other.
      const installUrl =
        provider === "docker" ? "/api/connect.sh" : "/api/manifest.yaml";
      const [scriptText, ingest] = await Promise.all([
        // The install script is plain text, not JSON, so it stays a raw fetch.
        fetch(installUrl, {
          headers: { Authorization: `Bearer ${minted.token}` },
        }).then(async (res) => {
          if (!res.ok) throw new Error(`${installUrl} ${res.status}`);
          return res.text();
        }),
        monitoring === "byo"
          ? apiFetch<{ token: string; ingestUrl: string }>(
              "/api/ingest-credential/ensure",
              { method: "POST" },
            )
          : Promise.resolve(null),
      ]);
      setInstallText(scriptText);
      if (ingest) {
        setIngestToken(ingest.token);
        setIngestUrl(ingest.ingestUrl);
      }
    } catch (err) {
      // A duplicate server name is a 409: send the operator back to fix it.
      if (err instanceof ApiError && err.status === 409) {
        setInstallError(err.message);
        setStep(0);
        return;
      }
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

  const sendTestAlert = useMutation({
    mutationFn: async (runnerId: string): Promise<string> => {
      const body = await apiFetch<{ hostname?: string; error?: string }>(
        "/api/alerts/test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runnerId }),
        },
      );
      if (!body.hostname)
        throw new Error(body.error ?? "Failed to send test alert");
      return body.hostname;
    },
    onMutate: () => setVerifyResult(null),
    onSuccess: (hostname) => setVerifyResult({ ok: true, hostname }),
    onError: (err) =>
      setVerifyResult({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to send test alert",
      }),
  });

  const trimmedServerName = serverName.trim();

  return (
    <Modal opened={opened} onClose={handleClose} title="Add a server" size="lg">
      <Stepper active={step} onStepClick={setStep} allowNextStepsSelect={false}>
        <Stepper.Step label="Server">
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

            <Radio.Group
              label="Monitoring"
              description="Nightwatch needs Prometheus and Alertmanager to receive alerts."
              value={monitoring ?? ""}
              onChange={(v) => setMonitoring(v as Monitoring)}
            >
              <Stack gap="xs" mt="xs">
                <Radio
                  value="bundled"
                  label="Bundle Prometheus + Alertmanager for me"
                />
                <Radio value="byo" label="I already run my own monitoring" />
              </Stack>
            </Radio.Group>

            {installError !== null && step === 0 && (
              <Text size="sm" c="red">
                {installError}
              </Text>
            )}

            <Group justify="flex-end">
              <Button
                disabled={!canContinueFromServer}
                onClick={() => void handleStartInstall()}
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
              <Stack gap="md">
                <Stack gap="xs">
                  <Text size="sm">
                    Run this on the target server to install the runner:
                  </Text>
                  <Group gap="xs" align="flex-start" wrap="nowrap">
                    <Code
                      block
                      style={{
                        flex: 1,
                        fontFamily: "var(--font-mono)",
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
                </Stack>

                {monitoring === "bundled" && (
                  <Alert color="blue" title="Monitoring bundled">
                    Prometheus, Alertmanager and cAdvisor ship inside the runner
                    and are wired to Nightwatch automatically. Nothing else to
                    configure.
                  </Alert>
                )}

                {monitoring === "byo" &&
                  provider &&
                  ingestToken !== null &&
                  ingestUrl !== null && (
                    <WizardMonitoringStep
                      provider={provider}
                      trimmedServerName={trimmedServerName}
                      ingestToken={ingestToken}
                      ingestUrl={ingestUrl}
                    />
                  )}

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

        <Stepper.Step label="Verify">
          <Stack gap="md" mt="md">
            <Text size="sm">
              Send a synthetic alert through the full pipeline to confirm it
              reaches this server.
            </Text>

            <Button
              style={{ alignSelf: "flex-start" }}
              loading={sendTestAlert.isPending}
              disabled={!connectedRunner}
              onClick={() =>
                connectedRunner && sendTestAlert.mutate(connectedRunner.id)
              }
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
