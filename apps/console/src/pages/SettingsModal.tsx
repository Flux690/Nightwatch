import { useEffect, useState } from "react";
import { Modal as MantineModal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfig, ReasoningEffort } from "@nightwatch/shared";
import { X } from "lucide-react";
import { Autocomplete } from "../ui/Autocomplete.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Checkbox } from "../ui/Checkbox.js";
import { Group } from "../ui/Group.js";
import { IconButton } from "../ui/IconButton.js";
import { NumberInput } from "../ui/NumberInput.js";
import { PasswordInput } from "../ui/PasswordInput.js";
import { Select } from "../ui/Select.js";
import { Text } from "../ui/Text.js";
import { TextInput } from "../ui/TextInput.js";
import { toast } from "../ui/Toast.js";
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

type SectionId = "model" | "api-key" | "loop" | "alerting" | "account";

const SECTIONS: { id: SectionId; label: string; description: string }[] = [
  {
    id: "model",
    label: "Model",
    description:
      "Provider, endpoint and generation limits for the investigation agent.",
  },
  {
    id: "api-key",
    label: "API key",
    description:
      "Stored write-only. Testing a new key replaces the current one.",
  },
  {
    id: "loop",
    label: "Loop",
    description: "Retry and timeout budgets for a single investigation run.",
  },
  {
    id: "alerting",
    label: "Alerting",
    description:
      "Credential your Alertmanager uses to push alerts into Nightwatch.",
  },
  {
    id: "account",
    label: "Account",
    description: "Session control for every signed-in device.",
  },
];

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

export function SettingsModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { logoutAll } = useAuth();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [section, setSection] = useState<SectionId>("model");

  const { data: config } = useQuery<AgentConfig>({
    queryKey: ["config"],
    queryFn: () => apiFetch<AgentConfig>("/api/config"),
    enabled: opened,
  });

  const { data: modelsData } = useQuery<{ models: string[] }>({
    queryKey: ["config/models"],
    queryFn: () =>
      apiFetch<{ models: string[] }>("/api/config/models").catch(() => ({
        models: [],
      })),
    staleTime: 30_000,
    enabled: opened,
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
      toast.show({
        title: "Settings saved",
        message: "Your changes have been saved.",
        variant: "success",
      });
    },
    onError: (err) => {
      toast.show({
        title: "Save failed",
        message: err instanceof Error ? err.message : "Unknown error",
        variant: "error",
      });
    },
  });

  function handleSave(e: React.FormEvent): void {
    e.preventDefault();
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
  const dirty =
    form && config ? Object.keys(buildDelta(form, config)).length > 0 : false;

  /* Closing with unsaved edits asks first; a discarded form re-syncs to the
     persisted config so a re-open never shows stale edits. */
  function handleClose(): void {
    if (dirty) {
      const discard = window.confirm(
        "Discard unsaved changes? Your edits will be lost.",
      );
      if (!discard) return;
      setForm(config ?? null);
    }
    setNewApiKey("");
    setTestResult(null);
    onClose();
  }

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <MantineModal
      opened={opened}
      onClose={handleClose}
      centered
      size={920}
      fullScreen={isMobile === true}
      withCloseButton={false}
      padding={0}
      classNames={{
        content: "settings-modal",
        body: "settings-modal__body",
        overlay: "settings-modal__overlay",
      }}
    >
      <div className="settings-modal__layout">
        <nav className="settings-modal__rail" aria-label="Settings sections">
          <h2 className="settings-modal__rail-title">Settings</h2>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="settings-modal__rail-item"
              data-active={section === s.id ? "true" : undefined}
              aria-current={section === s.id ? "true" : undefined}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-modal__pane">
          <IconButton
            aria-label="Close settings"
            className="settings-modal__close"
            onClick={handleClose}
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>

          <form
            onSubmit={handleSave}
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
            }}
          >
            <div className="settings-modal__pane-body">
              <h3 className="settings-modal__pane-title">{active.label}</h3>
              <p className="settings-modal__pane-desc">{active.description}</p>

              {form && section === "model" && (
                <div className="settings-modal__fields">
                  <Select
                    label="Protocol"
                    w="md"
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
                    w="md"
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

                  <Autocomplete
                    label="Model"
                    w="md"
                    data={availableModels}
                    value={form.model}
                    onChange={(v) => setField("model", v)}
                  />

                  <NumberInput
                    label="Max output tokens"
                    w="xs"
                    step={1000}
                    value={form.maxOutputTokens}
                    onChange={(v) =>
                      setField("maxOutputTokens", numberValue(v))
                    }
                  />

                  {isAnthropic && (
                    <>
                      <Select
                        label="Thinking mode"
                        w="md"
                        data={[
                          {
                            value: "adaptive",
                            label: "Adaptive (extended thinking)",
                          },
                          { value: "off", label: "Off" },
                        ]}
                        value={form.thinking}
                        onChange={(v) =>
                          v &&
                          setField("thinking", v as AgentConfig["thinking"])
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
                      w="sm"
                      data={[
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium" },
                        { value: "high", label: "High" },
                      ]}
                      value={form.reasoningEffort ?? null}
                      onChange={(v) =>
                        setField(
                          "reasoningEffort",
                          (v as ReasoningEffort) ?? null,
                        )
                      }
                      clearable
                      placeholder="Not set"
                    />
                  )}
                </div>
              )}

              {form && section === "api-key" && (
                <div className="settings-modal__fields">
                  <div>
                    <Text className="text-xs text-ink-muted">Current key</Text>
                    <Text className="text-sm" style={{ marginTop: 2 }}>
                      {form.apiKeyMasked ? form.apiKeyMasked : "Not configured"}
                    </Text>
                  </div>
                  <PasswordInput
                    label="New API key"
                    w="md"
                    placeholder="Paste API key"
                    value={newApiKey}
                    onChange={(e) => {
                      setNewApiKey(e.currentTarget.value);
                      setTestResult(null);
                    }}
                  />
                  <Group className="gap-2 items-center">
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      loading={testConnection.isPending}
                      onClick={() => handleTestConnection()}
                    >
                      Test connection
                    </Button>
                    {testResult?.ok && (
                      <Badge intent="success">Connected</Badge>
                    )}
                    {testResult && !testResult.ok && (
                      <Badge intent="error">
                        {ERROR_LABELS[testResult.error] ?? testResult.error}
                      </Badge>
                    )}
                  </Group>
                </div>
              )}

              {form && section === "loop" && (
                <div className="settings-row-grid">
                  <NumberInput
                    label="Max retries"
                    step={1}
                    value={form.maxRetries}
                    onChange={(v) => setField("maxRetries", numberValue(v))}
                  />
                  <NumberInput
                    label="Request timeout (ms)"
                    step={1000}
                    value={form.requestTimeoutMs}
                    onChange={(v) =>
                      setField("requestTimeoutMs", numberValue(v))
                    }
                  />
                  <NumberInput
                    label="Hard timeout (ms)"
                    step={1000}
                    value={form.hardTimeoutMs}
                    onChange={(v) => setField("hardTimeoutMs", numberValue(v))}
                  />
                  <NumberInput
                    label="Tool timeout (ms)"
                    step={1000}
                    value={form.toolTimeoutMs}
                    onChange={(v) => setField("toolTimeoutMs", numberValue(v))}
                  />
                </div>
              )}

              {section === "alerting" && <IngestCredentialSection />}

              {section === "account" && (
                <div>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void logoutAll()}
                  >
                    Log out all devices
                  </Button>
                </div>
              )}
            </div>

            <div className="settings-modal__footer">
              <Button
                type="submit"
                disabled={!dirty || saveConfig.isPending}
                loading={saveConfig.isPending}
              >
                Save
              </Button>
            </div>
          </form>
        </div>
      </div>
    </MantineModal>
  );
}
