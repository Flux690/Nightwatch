import { useEffect, useState } from "react";
import {
  Autocomplete,
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfig, ReasoningEffort } from "@nightwatch/shared";
import { apiFetch } from "../api/client.js";
import { IngestCredentialSection } from "./IngestCredentialSection.js";
import { useAuth } from "../auth/AuthContext.js";

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

export function SettingsPage(): React.JSX.Element {
  const { logoutAll } = useAuth();
  const { data: config } = useQuery<AgentConfig>({
    queryKey: ["config"],
    queryFn: () => apiFetch<AgentConfig>("/api/config"),
  });

  const { data: modelsData } = useQuery<{ models: string[] }>({
    queryKey: ["config/models"],
    // Best-effort: the model list is a convenience, so fall back to empty rather
    // than surfacing an error if it can't be fetched.
    queryFn: () =>
      apiFetch<{ models: string[] }>("/api/config/models").catch(() => ({
        models: [],
      })),
    staleTime: 30_000,
  });

  const availableModels = modelsData?.models ?? [];

  const queryClient = useQueryClient();
  const [form, setForm] = useState<AgentConfig | null>(null);
  const [newApiKey, setNewApiKey] = useState("");
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (config) setForm(config);
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: (delta: Partial<AgentConfig>) =>
      apiFetch<AgentConfig>("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delta),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["config"], updated);
      notifications.show({
        color: "green",
        title: "Settings saved",
        message: "Your changes have been saved.",
      });
    },
    onError: (err) => {
      notifications.show({
        color: "red",
        title: "Save failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  function handleSave(): void {
    if (!form || !config) return;
    const delta = buildDelta(form, config);
    if (Object.keys(delta).length === 0) return;
    saveConfig.mutate(delta);
  }

  const testConnection = useMutation({
    mutationFn: (vars: { apiKey: string; model: string | undefined }) =>
      apiFetch<TestResult>("/api/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      }),
    onSuccess: async (data) => {
      setTestResult(data);
      if (data.ok) {
        await queryClient.invalidateQueries({ queryKey: ["config"] });
        setNewApiKey("");
      }
    },
    // The endpoint returns { ok: false } for a bad key on a 2xx; a thrown error
    // here is the request itself failing, which is an unreachable endpoint.
    onError: () => setTestResult({ ok: false, error: "unreachable" }),
  });

  function handleTestConnection(): void {
    if (!newApiKey.trim()) return;
    setTestResult(null);
    testConnection.mutate({ apiKey: newApiKey, model: form?.model });
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
  const hasChanges =
    form && config ? Object.keys(buildDelta(form, config)).length > 0 : false;

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
                  loading={testConnection.isPending}
                  onClick={() => handleTestConnection()}
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

          <Button
            onClick={() => handleSave()}
            disabled={!hasChanges || saveConfig.isPending}
            loading={saveConfig.isPending}
            style={{ alignSelf: "flex-start" }}
          >
            Save
          </Button>
        </Stack>
      )}

      <IngestCredentialSection />

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
