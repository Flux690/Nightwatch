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
import { useMutation, useQuery } from "@tanstack/react-query";
import type { RunnerRecord } from "@nightwatch/shared";
import { ApiError, apiFetch } from "../api/client.js";
import { WizardMonitoringStep } from "./WizardMonitoringStep.js";

export type Provider = "docker" | "kubernetes";

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
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [installText, setInstallText] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
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

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["wizard-runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
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
    setVerifyResult(null);
    onClose();
  }

  async function handleChooseProvider(): Promise<void> {
    if (!canContinueFromProvider) return;
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

      // The install script is plain text, not JSON, so it stays a raw fetch.
      const installUrl =
        provider === "docker" ? "/api/connect.sh" : "/api/manifest.yaml";
      const installRes = await fetch(installUrl, {
        headers: { Authorization: `Bearer ${minted.token}` },
      });
      if (!installRes.ok) throw new Error(`${installUrl} ${installRes.status}`);
      setInstallText(await installRes.text());
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
          {provider && (
            <WizardMonitoringStep
              provider={provider}
              trimmedServerName={trimmedServerName}
              onContinue={() => setStep(3)}
            />
          )}
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
