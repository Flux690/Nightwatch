import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import type { RunnerRecord } from "@nightwatch/shared";
import { AlertCircle, ArrowLeft, Copy } from "lucide-react";
import { Alert } from "../ui/Alert.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Code } from "../ui/Code.js";
import { Group } from "../ui/Group.js";
import { IconButton } from "../ui/IconButton.js";
import { Loader } from "../ui/Loader.js";
import { Radio, RadioGroup } from "../ui/Radio.js";
import { Stack } from "../ui/Stack.js";
import { Text } from "../ui/Text.js";
import { TextInput } from "../ui/TextInput.js";
import { ICON_INLINE, ICON_UI } from "../ui/iconProps.js";
import { ApiError, apiFetch } from "../api/client.js";
import { WizardMonitoringStep } from "./WizardMonitoringStep.js";

export type Provider = "docker" | "kubernetes";
type Monitoring = "bundled" | "byo";

interface MintedToken {
  id: string;
  token: string;
}

const RUNNER_POLL_MS = 3000;

const STEP_TITLES = [
  "Server details",
  "Install the runner",
  "Verify the pipeline",
];

function validateServerName(name: string): string | null {
  if (name.trim().length === 0) return "Server name is required";
  if (name.includes("/")) return "Server name must not contain '/'";
  return null;
}

function ProgressHeader({
  step,
  total,
}: {
  step: number;
  total: number;
}): React.JSX.Element {
  return (
    <div className="step-header">
      <div className="step-header__caption">
        Step {step + 1} of {total}
      </div>
      <div className="step-header__title">{STEP_TITLES[step]}</div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={step + 1}
        aria-valuetext={`Step ${step + 1} of ${total}: ${STEP_TITLES[step]}`}
      >
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            className="progress-track__segment"
            data-done={i <= step || undefined}
          />
        ))}
      </div>
    </div>
  );
}

export function AddServerPage(): React.JSX.Element {
  const navigate = useNavigate();
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

  const connectedRunner = runners?.find(
    (r) => r.token === mintedToken?.id && r.online && r.hostname !== null,
  );

  useEffect(() => {
    if (connectedRunner) setCommitted(true);
  }, [connectedRunner]);

  const tokenPending = mintedToken !== null && !committed;
  useBlocker({
    shouldBlockFn: () => {
      const leave = window.confirm(
        "Leave setup? The server token you generated will be revoked.",
      );
      if (!leave) return true;
      if (mintedToken !== null) {
        void apiFetch<void>(`/api/tokens/${mintedToken.id}`, {
          method: "DELETE",
        }).catch(() => {});
      }
      return false;
    },
    disabled: !tokenPending,
    enableBeforeUnload: () => tokenPending,
  });

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

      const installUrl =
        provider === "docker" ? "/api/connect.sh" : "/api/manifest.yaml";
      const [scriptText, ingest] = await Promise.all([
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
    <div className="page page--data page--prose">
      <Link to="/fleet" className="back-link">
        <ArrowLeft {...ICON_INLINE} />
        Fleet
      </Link>
      <header className="page-header">
        <h1 className="page-title">Add a server</h1>
      </header>

      <ProgressHeader step={step} total={3} />

      {step === 0 && (
        <Stack className="gap-8">
          <RadioGroup
            label="Which substrate is this server running?"
            value={provider ?? ""}
            onChange={(v) => setProvider(v as Provider)}
          >
            <Group className="mt-2">
              <Radio value="docker" label="Docker" />
              <Radio value="kubernetes" label="Kubernetes" />
            </Group>
          </RadioGroup>

          <TextInput
            label="Server name"
            w="md"
            description="A unique name for this server in your fleet. Immutable once installed."
            placeholder="e.g. prod-web-01"
            value={serverName}
            onChange={(e) => setServerName(e.currentTarget.value)}
            onBlur={() => setServerNameTouched(true)}
            error={
              serverNameError ? (
                <>
                  <AlertCircle size={12} aria-hidden="true" />
                  {serverNameError}
                </>
              ) : undefined
            }
          />

          <RadioGroup
            label="Monitoring"
            description="Nightwatch needs Prometheus and Alertmanager to receive alerts."
            value={monitoring ?? ""}
            onChange={(v) => setMonitoring(v as Monitoring)}
          >
            <Stack className="gap-2 mt-2">
              <Radio
                value="bundled"
                label="Bundle Prometheus + Alertmanager for me"
              />
              <Radio value="byo" label="I already run my own monitoring" />
            </Stack>
          </RadioGroup>

          {installError !== null && (
            <Text className="text-sm text-status-failed">{installError}</Text>
          )}

          <div className="step-actions">
            <span />
            <Button
              disabled={!canContinueFromServer}
              onClick={() => void handleStartInstall()}
            >
              Continue
            </Button>
          </div>
        </Stack>
      )}

      {step === 1 && (
        <Stack className="gap-4">
          {minting && (
            <Group className="gap-2">
              <Loader />
              <Text className="text-sm text-ink-muted">
                Generating a runner token...
              </Text>
            </Group>
          )}

          {installError !== null && (
            <Text className="text-sm text-status-failed">{installError}</Text>
          )}

          {installText !== null && (
            <Stack className="gap-4">
              <Stack className="gap-2">
                <Text className="text-sm">
                  Run this on the target server to install the runner:
                </Text>
                <Group className="gap-2 items-start flex-nowrap">
                  <Code
                    block
                    style={{
                      flex: 1,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 240,
                      overflow: "auto",
                    }}
                  >
                    {installText}
                  </Code>
                  <IconButton
                    aria-label="Copy install command"
                    onClick={copyInstallText}
                  >
                    <Copy {...ICON_UI} />
                  </IconButton>
                </Group>
              </Stack>

              {monitoring === "bundled" && (
                <Alert intent="info" title="Monitoring bundled">
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

              <Group className="gap-2 items-center">
                {connectedRunner ? (
                  <Badge intent="success">Runner connected</Badge>
                ) : (
                  <Group className="gap-2">
                    <Loader />
                    <Text className="text-sm text-ink-muted">
                      Waiting for the runner to connect...
                    </Text>
                  </Group>
                )}
              </Group>
            </Stack>
          )}

          <div className="step-actions">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button disabled={!connectedRunner} onClick={() => setStep(2)}>
              Continue
            </Button>
          </div>
        </Stack>
      )}

      {step === 2 && (
        <Stack className="gap-4">
          <Text className="text-sm">
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
            <Alert intent="success" title="Pipeline verified">
              Alert received and routed to {verifyResult.hostname}.
            </Alert>
          )}
          {verifyResult?.ok === false && (
            <Alert intent="error" title="Verification failed">
              {verifyResult.error}
            </Alert>
          )}

          <div className="step-actions">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: "/fleet" })}
            >
              Done
            </Button>
          </div>
        </Stack>
      )}
    </div>
  );
}
