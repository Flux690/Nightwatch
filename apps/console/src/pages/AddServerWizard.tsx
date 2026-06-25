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
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { RunnerRecord } from "@nightwatch/shared";

export type Provider = "docker" | "kubernetes";

interface MintedToken {
  id: string;
  token: string;
}

const RUNNER_POLL_MS = 3000;

export function AddServerWizard({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [installText, setInstallText] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [generatingIngest, setGeneratingIngest] = useState(false);
  const [ingestToken, setIngestToken] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<
    { ok: true; hostname: string } | { ok: false; error: string } | null
  >(null);

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
    setMintedToken(null);
    setInstallText(null);
    setInstallError(null);
    setIngestToken(null);
    setVerifyResult(null);
    onClose();
  }

  async function handleChooseProvider(): Promise<void> {
    if (!provider) return;
    setStep(1);
    setMinting(true);
    setInstallError(null);
    try {
      const tokenRes = await fetch("/api/tokens", { method: "POST" });
      if (!tokenRes.ok) throw new Error(`tokens ${tokenRes.status}`);
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

  async function handleGenerateIngestCredential(): Promise<void> {
    setGeneratingIngest(true);
    try {
      const res = await fetch("/api/ingest-credential", { method: "POST" });
      if (!res.ok) throw new Error(`ingest-credential ${res.status}`);
      const { token } = (await res.json()) as { token: string };
      setIngestToken(token);
    } finally {
      setGeneratingIngest(false);
    }
  }

  function copyIngestToken(): void {
    if (ingestToken !== null) void navigator.clipboard.writeText(ingestToken);
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
            <Group justify="flex-end">
              <Button
                disabled={provider === null}
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

            {installError !== null && (
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

            <Button
              size="xs"
              variant="default"
              style={{ alignSelf: "flex-start" }}
              loading={generatingIngest}
              onClick={() => void handleGenerateIngestCredential()}
            >
              {ingestCredential?.configured
                ? "Rotate credential"
                : "Generate credential"}
            </Button>

            {ingestToken !== null && (
              <Alert
                color="yellow"
                title="You won't see this again - if lost, rotate to issue a new one"
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
                      onClick={copyIngestToken}
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
                      `            credentials: '${ingestToken}'`,
                    ].join("\n")}
                  </Code>
                </Stack>
              </Alert>
            )}

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
