import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfig, ReasoningEffort } from "@nightwatch/shared";
import { useAuth } from "../auth/AuthContext.js";

// Mirrors the TokenMeta shape from apps/api/src/db/tokens.ts. Defined locally
// because console must not import from apps/api directly.
interface TokenMetaShape {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface GeneratedToken {
  id: string;
  plaintext: string;
  label: string | null;
  createdAt: string;
}

type TestResult =
  | { ok: true }
  | { ok: false; error: "bad_key" | "unreachable" | "unknown_model" };

const ERROR_LABELS: Record<string, string> = {
  bad_key: "Invalid API key",
  unreachable: "Endpoint unreachable",
  unknown_model: "Model not found on endpoint",
};

function buildDelta(
  form: AgentConfig,
  base: AgentConfig,
): Partial<AgentConfig> {
  const delta: Partial<AgentConfig> = {};
  for (const key of Object.keys(form) as (keyof AgentConfig)[]) {
    if (key === "apiKeyMasked") continue;
    if (!Object.is(form[key], base[key])) {
      Object.assign(delta, { [key]: form[key] });
    }
  }
  return delta;
}

const SAVE_DEBOUNCE_MS = 400;

export function SettingsPage(): React.JSX.Element {
  const { logoutAll } = useAuth();
  const { data: config } = useQuery<AgentConfig>({
    queryKey: ["config"],
    queryFn: () =>
      fetch("/api/config").then((r) => {
        if (!r.ok) throw new Error(`config ${r.status}`);
        return r.json() as Promise<AgentConfig>;
      }),
  });

  const { data: tokensData, refetch: refetchTokens } = useQuery<{
    tokens: TokenMetaShape[];
  }>({
    queryKey: ["tokens"],
    queryFn: () =>
      fetch("/api/tokens").then((r) => {
        if (!r.ok) throw new Error(`tokens ${r.status}`);
        return r.json() as Promise<{ tokens: TokenMetaShape[] }>;
      }),
  });

  const { data: modelsData } = useQuery<{ models: string[] }>({
    queryKey: ["config/models"],
    queryFn: () =>
      fetch("/api/config/models").then((r) => {
        if (!r.ok) return { models: [] };
        return r.json() as Promise<{ models: string[] }>;
      }),
    staleTime: 30_000,
  });

  const availableModels = modelsData?.models ?? [];
  const tokens = tokensData?.tokens ?? [];

  const queryClient = useQueryClient();
  const [form, setForm] = useState<AgentConfig | null>(null);
  const [newApiKey, setNewApiKey] = useState("");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [tokenLabel, setTokenLabel] = useState("");
  const [generatedToken, setGeneratedToken] = useState<GeneratedToken | null>(
    null,
  );
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (config) setForm(config);
  }, [config]);

  async function save(): Promise<void> {
    if (!form || !config) return;
    const delta = buildDelta(form, config);
    if (Object.keys(delta).length === 0) return;
    const res = await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(delta),
    });
    if (!res.ok) throw new Error(`config patch ${res.status}`);
    const updated = (await res.json()) as AgentConfig;
    queryClient.setQueryData(["config"], updated);
  }

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function requestSave(): void {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  }

  async function handleTestConnection(): Promise<void> {
    if (!newApiKey.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: newApiKey, model: form?.model }),
      });
      const data = (await res.json()) as TestResult;
      setTestResult(data);
      if (data.ok) {
        await queryClient.invalidateQueries({ queryKey: ["config"] });
        setNewApiKey("");
      }
    } finally {
      setTesting(false);
    }
  }

  async function handleGenerate(): Promise<void> {
    setGenerating(true);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: tokenLabel.trim() || undefined }),
      });
      if (!res.ok) throw new Error(`generate failed ${res.status}`);
      const data = (await res.json()) as {
        id: string;
        token: string;
        label: string | null;
        createdAt: string;
      };
      setGeneratedToken({
        id: data.id,
        plaintext: data.token,
        label: data.label,
        createdAt: data.createdAt,
      });
      setTokenLabel("");
      await refetchTokens();
    } finally {
      setGenerating(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setDeleting(id);
    try {
      await fetch(`/api/tokens/${id}`, { method: "DELETE" });
      await refetchTokens();
      queryClient.removeQueries({ queryKey: ["runners"] });
    } finally {
      setDeleting(null);
    }
  }

  function copy(text: string): void {
    void navigator.clipboard.writeText(text);
  }

  function setField<K extends keyof AgentConfig>(
    key: K,
    value: AgentConfig[K],
  ): void {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function numberValue(value: string | number): number {
    return typeof value === "number" ? value : Number(value);
  }

  const isAnthropic = form?.provider === "anthropic";

  const installCommand = generatedToken
    ? `curl -fsSL ${window.location.origin}/install.sh | sh -s -- ${generatedToken.plaintext}`
    : null;

  return (
    <div
      className="nw-page"
      style={{ padding: "var(--mantine-spacing-md)", maxWidth: 520 }}
    >
      <Title order={2} size="h4" mb="md">
        Settings
      </Title>

      {form && (
        <Stack gap="lg">
          <Stack gap="sm">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Model
            </Text>

            <Select
              label="Protocol"
              data={[
                { value: "anthropic", label: "Anthropic native" },
                { value: "openai", label: "OpenAI-compatible" },
              ]}
              value={form.provider}
              onChange={(v) =>
                v && setField("provider", v as AgentConfig["provider"])
              }
              allowDeselect={false}
            />

            <TextInput
              label="Base URL"
              placeholder={
                form.provider === "anthropic"
                  ? "https://api.anthropic.com"
                  : "https://api.openai.com/v1"
              }
              value={form.baseUrl ?? ""}
              onChange={(e) =>
                setField("baseUrl", e.currentTarget.value || undefined)
              }
            />

            <Stack gap={4}>
              <Text size="sm" fw={500}>
                API key
              </Text>
              <Text size="sm" c="dimmed">
                {form.apiKeyMasked ? form.apiKeyMasked : "Not configured"}
              </Text>
              <TextInput
                placeholder="Paste API key"
                type="password"
                value={newApiKey}
                onChange={(e) => {
                  setNewApiKey(e.currentTarget.value);
                  setTestResult(null);
                }}
              />
              <Group gap="xs" align="center">
                <Button
                  size="xs"
                  variant="default"
                  loading={testing}
                  onClick={() => void handleTestConnection()}
                >
                  Test connection
                </Button>
                {testResult?.ok && (
                  <Badge color="green" variant="light">
                    Connected
                  </Badge>
                )}
                {testResult && !testResult.ok && (
                  <Badge color="red" variant="light">
                    {ERROR_LABELS[testResult.error] ?? testResult.error}
                  </Badge>
                )}
              </Group>
            </Stack>

            <Autocomplete
              label="Model"
              data={availableModels}
              value={form.model}
              onChange={(v) => setField("model", v)}
            />

            <NumberInput
              label="Max output tokens"
              value={form.maxOutputTokens}
              onChange={(v) => setField("maxOutputTokens", numberValue(v))}
            />

            {isAnthropic && (
              <>
                <Select
                  label="Thinking mode"
                  data={[
                    {
                      value: "adaptive",
                      label: "Adaptive (extended thinking)",
                    },
                    { value: "off", label: "Off" },
                  ]}
                  value={form.thinking}
                  onChange={(v) =>
                    v && setField("thinking", v as AgentConfig["thinking"])
                  }
                  allowDeselect={false}
                />
                <Checkbox
                  label="Prompt caching"
                  checked={form.promptCaching ?? true}
                  onChange={(e) =>
                    setField("promptCaching", e.currentTarget.checked)
                  }
                />
              </>
            )}

            {!isAnthropic && (
              <Select
                label="Reasoning effort"
                data={[
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ]}
                value={form.reasoningEffort ?? null}
                onChange={(v) =>
                  setField("reasoningEffort", (v as ReasoningEffort) ?? null)
                }
                clearable
                placeholder="Not set"
              />
            )}
          </Stack>

          <Stack gap="sm">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Loop
            </Text>
            <NumberInput
              label="Max retries"
              value={form.maxRetries}
              onChange={(v) => setField("maxRetries", numberValue(v))}
            />
            <NumberInput
              label="Request timeout (ms)"
              value={form.requestTimeoutMs}
              onChange={(v) => setField("requestTimeoutMs", numberValue(v))}
            />
            <NumberInput
              label="Max tool calls"
              value={form.maxToolCalls}
              onChange={(v) => setField("maxToolCalls", numberValue(v))}
            />
            <NumberInput
              label="Hard timeout (ms)"
              value={form.hardTimeoutMs}
              onChange={(v) => setField("hardTimeoutMs", numberValue(v))}
            />
            <NumberInput
              label="Tool timeout (ms)"
              value={form.toolTimeoutMs}
              onChange={(v) => setField("toolTimeoutMs", numberValue(v))}
            />
          </Stack>

          <Button onClick={requestSave} style={{ alignSelf: "flex-start" }}>
            Save
          </Button>
        </Stack>
      )}

      {/* ── Runner tokens ──────────────────────────────────────────────────── */}
      <Stack gap="sm" mt="xl">
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          Runner tokens
        </Text>

        {/* One-time plaintext display immediately after generation */}
        {generatedToken && (
          <Alert
            color="yellow"
            title="Copy this token now — it will not be shown again"
            withCloseButton
            onClose={() => setGeneratedToken(null)}
          >
            <Stack gap="xs">
              <Group gap="xs" align="flex-start" wrap="nowrap">
                <Code
                  block
                  style={{
                    flex: 1,
                    fontFamily: "var(--nw-mono)",
                    wordBreak: "break-all",
                  }}
                  aria-label="New runner token"
                >
                  {generatedToken.plaintext}
                </Code>
                <ActionIcon
                  variant="default"
                  size="lg"
                  aria-label="Copy new token"
                  onClick={() => copy(generatedToken.plaintext)}
                >
                  ⧉
                </ActionIcon>
              </Group>
              {installCommand && (
                <>
                  <Text size="xs" fw={500}>
                    Install command
                  </Text>
                  <Group gap="xs" align="flex-start" wrap="nowrap">
                    <Code
                      block
                      style={{ flex: 1, fontFamily: "var(--nw-mono)" }}
                    >
                      {installCommand}
                    </Code>
                    <ActionIcon
                      variant="default"
                      size="lg"
                      aria-label="Copy install command"
                      onClick={() => copy(installCommand)}
                    >
                      ⧉
                    </ActionIcon>
                  </Group>
                </>
              )}
            </Stack>
          </Alert>
        )}

        {/* Token list */}
        {tokens.length > 0 && (
          <Stack gap={4}>
            {tokens.map((t) => (
              <Group
                key={t.id}
                justify="space-between"
                align="center"
                style={{
                  borderBottom: "1px solid var(--nw-border)",
                  paddingBottom: "var(--mantine-spacing-xs)",
                }}
              >
                <Stack gap={2}>
                  <Text size="sm" fw={500}>
                    {t.label ?? "Unlabeled"}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {t.id.slice(0, 8)}…
                    {t.lastUsedAt
                      ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                      : " · never used"}
                  </Text>
                </Stack>
                <Button
                  size="xs"
                  color="red"
                  variant="subtle"
                  loading={deleting === t.id}
                  aria-label={`Delete token ${t.label ?? t.id.slice(0, 8)}`}
                  onClick={() => void handleDelete(t.id)}
                >
                  Delete
                </Button>
              </Group>
            ))}
          </Stack>
        )}

        {tokens.length === 0 && !generatedToken && (
          <Text size="sm" c="dimmed">
            No active tokens. Generate one to connect a runner.
          </Text>
        )}

        {/* Generate form */}
        <Group gap="xs" align="flex-end">
          <TextInput
            label="Label (optional)"
            placeholder="e.g. prod-server"
            value={tokenLabel}
            onChange={(e) => setTokenLabel(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button
            loading={generating}
            onClick={() => void handleGenerate()}
            style={{ marginBottom: 0 }}
            aria-label="Generate token"
          >
            Generate token
          </Button>
        </Group>
      </Stack>

      <Stack gap="sm" mt="xl">
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          Account
        </Text>
        <Button
          color="red"
          variant="subtle"
          style={{ alignSelf: "flex-start" }}
          onClick={() => void logoutAll()}
        >
          Log out all devices
        </Button>
      </Stack>
    </div>
  );
}
