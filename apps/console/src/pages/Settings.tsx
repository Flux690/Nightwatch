import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Button,
  Code,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfig } from "@nightwatch/shared";

// Only the keys that differ from the loaded baseline are sent, so PATCH carries
// the delta and nothing else.
function buildDelta(
  form: AgentConfig,
  base: AgentConfig,
): Partial<AgentConfig> {
  const delta: Partial<AgentConfig> = {};
  for (const key of Object.keys(form) as (keyof AgentConfig)[]) {
    if (!Object.is(form[key], base[key])) {
      Object.assign(delta, { [key]: form[key] });
    }
  }
  return delta;
}

const SAVE_DEBOUNCE_MS = 400;

export function SettingsPage(): React.JSX.Element {
  const { data: config } = useQuery<AgentConfig>({
    queryKey: ["config"],
    queryFn: () =>
      fetch("/api/config").then((r) => {
        if (!r.ok) throw new Error(`config ${r.status}`);
        return r.json() as Promise<AgentConfig>;
      }),
  });

  const { data: tokenData } = useQuery<{ token: string }>({
    queryKey: ["token"],
    queryFn: () =>
      fetch("/api/token").then((r) => {
        if (!r.ok) throw new Error(`token ${r.status}`);
        return r.json() as Promise<{ token: string }>;
      }),
  });
  const token = tokenData?.token ?? "";

  const queryClient = useQueryClient();
  const [form, setForm] = useState<AgentConfig | null>(null);

  // Hydrate the editable form once the server config arrives. The query result
  // stays the baseline we diff against when saving.
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

  // Collapse rapid Save clicks into one trailing-edge request.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function requestSave(): void {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  }

  function copy(text: string): void {
    void navigator.clipboard.writeText(text);
  }

  // The one-line onboarding command: pipe the install script through a shell
  // with the deployment token as a positional argument. Operators paste this
  // into any server to attach a new runner.
  const installCommand = `curl -fsSL ${window.location.origin}/install.sh | sh -s -- ${token}`;

  function setField<K extends keyof AgentConfig>(
    key: K,
    value: AgentConfig[K],
  ): void {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function numberValue(value: string | number): number {
    return typeof value === "number" ? value : Number(value);
  }

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
              label="Provider"
              data={["anthropic", "openai"]}
              value={form.provider}
              onChange={(v) =>
                // Select only emits values from `data` above, which are exactly
                // the provider union members.
                v && setField("provider", v as AgentConfig["provider"])
              }
              allowDeselect={false}
            />
            <TextInput
              label="Model"
              value={form.model}
              onChange={(e) => setField("model", e.currentTarget.value)}
            />
            <Select
              label="Thinking"
              data={["adaptive", "off"]}
              value={form.thinking}
              onChange={(v) =>
                // Select only emits values from `data` above, which are exactly
                // the thinking-mode union members.
                v && setField("thinking", v as AgentConfig["thinking"])
              }
              allowDeselect={false}
            />
            <NumberInput
              label="Max output tokens"
              value={form.maxOutputTokens}
              onChange={(v) => setField("maxOutputTokens", numberValue(v))}
            />
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

      {token && (
        <Stack gap="sm" mt="lg">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Deployment
          </Text>
          <Group gap="xs" align="flex-end">
            <PasswordInput
              label="Deployment token"
              value={token}
              readOnly
              style={{ flex: 1 }}
              styles={{ innerInput: { fontFamily: "var(--nw-mono)" } }}
            />
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Copy deployment token"
              onClick={() => copy(token)}
            >
              ⧉
            </ActionIcon>
          </Group>

          <Text size="sm" fw={500}>
            Install command
          </Text>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <Code block style={{ flex: 1, fontFamily: "var(--nw-mono)" }}>
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
        </Stack>
      )}
    </div>
  );
}
