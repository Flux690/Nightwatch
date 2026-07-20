import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfig, ReasoningEffort } from "@nightwatch/shared";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ICON_UI } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { useAuth } from "@/auth/AuthContext";

type TestResult =
  | { ok: true }
  | { ok: false; error: "bad_key" | "unreachable" | "unknown_model" };

const ERROR_LABELS: Record<string, string> = {
  bad_key: "Invalid API key",
  unreachable: "Endpoint unreachable",
  unknown_model: "Model not found on endpoint",
};

type SectionId = "model" | "loop" | "sandbox" | "account";

const SECTIONS: { id: SectionId; label: string; description: string }[] = [
  {
    id: "model",
    label: "Provider",
    description:
      "Protocol, endpoint, API key and generation limits for the investigation agent.",
  },
  {
    id: "loop",
    label: "Loop",
    description: "Retry and timeout budgets for a single investigation run.",
  },
  {
    id: "sandbox",
    label: "Sandbox",
    description:
      "Lifecycle and resource limits for per-session code sandboxes.",
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
  const [section, setSection] = useState<SectionId>("model");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

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
  });

  const saveApiKey = useMutation({
    mutationFn: (apiKey: string) =>
      apiFetch<{ apiKeyMasked: string }>("/api/config/key", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      }),
  });

  async function handleSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!form || !config) return;
    const delta = buildDelta(form, config);
    // The textarea keeps raw lines while typing; blanks are dropped on save.
    if (delta.sandboxAllowlistHosts !== undefined) {
      delta.sandboxAllowlistHosts = delta.sandboxAllowlistHosts
        .map((h) => h.trim())
        .filter((h) => h.length > 0);
    }
    const keyToSave = newApiKey.trim();
    // A changed key must pass Test connection before it can be saved.
    if (keyToSave && !testResult?.ok) return;
    if (Object.keys(delta).length === 0 && !keyToSave) return;

    try {
      await Promise.all([
        Object.keys(delta).length > 0
          ? saveConfig.mutateAsync(delta)
          : undefined,
        keyToSave ? saveApiKey.mutateAsync(keyToSave) : undefined,
      ]);
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      setNewApiKey("");
      setTestResult(null);
      toast.show({
        title: "Settings saved",
        message: "Your changes have been saved.",
        variant: "success",
      });
    } catch (err) {
      toast.show({
        title: "Save failed",
        message: err instanceof Error ? err.message : "Unknown error",
        variant: "error",
      });
    }
  }

  const testConnection = useMutation({
    mutationFn: (vars: {
      apiKey: string;
      model: string | undefined;
      provider: AgentConfig["provider"] | undefined;
      baseUrl: string | undefined;
    }) =>
      apiFetch<TestResult>("/api/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      }),
    onSuccess: (data) => setTestResult(data),
    onError: () => setTestResult({ ok: false, error: "unreachable" }),
  });

  function handleTestConnection(): void {
    if (!newApiKey.trim() || !form) return;
    setTestResult(null);
    testConnection.mutate({
      apiKey: newApiKey,
      model: form.model,
      provider: form.provider,
      baseUrl: form.baseUrl,
    });
  }

  function setField<K extends keyof AgentConfig>(
    key: K,
    value: AgentConfig[K],
  ): void {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  // Provider/baseUrl/model changes invalidate any prior test result - it was
  // only ever a verdict on the combination tested at the time.
  function setConnectionField<K extends "provider" | "baseUrl" | "model">(
    key: K,
    value: AgentConfig[K],
  ): void {
    setField(key, value);
    setTestResult(null);
  }

  function numberValue(value: string | number): number {
    return typeof value === "number" ? value : Number(value);
  }

  const isAnthropic = form?.provider === "anthropic";
  const keyDirty = newApiKey.trim() !== "";
  const keyUntested = keyDirty && !testResult?.ok;
  const configDirty =
    form && config ? Object.keys(buildDelta(form, config)).length > 0 : false;
  const dirty = configDirty || keyDirty;

  /* Closing with unsaved edits asks first; a discarded form re-syncs to the persisted config so a re-open never shows stale edits. */
  function handleClose(): void {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    setNewApiKey("");
    setTestResult(null);
    onClose();
  }

  function confirmDiscardEdits(): void {
    setForm(config ?? null);
    setNewApiKey("");
    setTestResult(null);
    setConfirmDiscard(false);
    onClose();
  }

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <Dialog
      open={opened}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden rounded-2xl p-0 shadow-overlay sm:max-w-page"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure the investigation agent's provider, API key, loop budgets,
          sandbox and account.
        </DialogDescription>

        <Tabs
          orientation="vertical"
          value={section}
          onValueChange={(v) => setSection(v as SectionId)}
          className="grid h-[min(640px,85vh)] grid-cols-1 grid-rows-[auto_1fr] gap-0 sm:grid-cols-[210px_minmax(0,1fr)] sm:grid-rows-[minmax(0,1fr)]"
        >
          <div className="flex flex-col border-b border-border bg-surface p-2 max-sm:flex-row max-sm:overflow-x-auto sm:border-b-0 sm:border-r sm:px-2 sm:py-4">
            <h2 className="mb-3 px-2.5 text-sm font-medium uppercase tracking-[0.06em] text-muted-foreground max-sm:hidden">
              Settings
            </h2>
            <TabsList
              variant="line"
              aria-label="Settings sections"
              className="flex w-full flex-col gap-0.5 rounded-none bg-transparent p-0 max-sm:flex-row max-sm:overflow-x-auto"
            >
              {SECTIONS.map((s) => (
                <TabsTrigger
                  key={s.id}
                  value={s.id}
                  className="justify-start rounded-md bg-transparent px-2.5 py-2 text-muted-foreground hover:bg-surface-hover hover:text-foreground data-active:!bg-surface-hover data-active:text-foreground max-sm:w-auto max-sm:whitespace-nowrap after:hidden"
                >
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="relative flex min-h-0 min-w-0 flex-col bg-card">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close settings"
              className="absolute right-3 top-3 z-[1]"
              onClick={handleClose}
            >
              <X {...ICON_UI} />
            </Button>

            <form
              onSubmit={handleSave}
              className="flex min-h-0 flex-1 flex-col"
            >
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-6">
                  <h3 className="mb-1 text-lg font-semibold tracking-[-0.2px] text-foreground">
                    {active.label}
                  </h3>
                  <p className="mb-5 text-sm text-muted-foreground">
                    {active.description}
                  </p>

                  <TabsContent value="model">
                    {form && (
                      <div className="flex flex-col items-start gap-4 [&>*]:w-full">
                        <Field className="max-w-80">
                          <FieldLabel htmlFor="settings-provider">
                            Protocol
                          </FieldLabel>
                          <NativeSelect
                            id="settings-provider"
                            className="w-full"
                            value={form.provider}
                            onChange={(e) =>
                              setConnectionField(
                                "provider",
                                e.currentTarget
                                  .value as AgentConfig["provider"],
                              )
                            }
                          >
                            <NativeSelectOption value="anthropic">
                              Anthropic native
                            </NativeSelectOption>
                            <NativeSelectOption value="openai">
                              OpenAI-compatible
                            </NativeSelectOption>
                          </NativeSelect>
                        </Field>

                        <Field className="max-w-80">
                          <FieldLabel htmlFor="settings-base-url">
                            Base URL
                          </FieldLabel>
                          <Input
                            id="settings-base-url"
                            placeholder={
                              form.provider === "anthropic"
                                ? "https://api.anthropic.com"
                                : "https://api.openai.com/v1"
                            }
                            value={form.baseUrl ?? ""}
                            onChange={(e) =>
                              setConnectionField(
                                "baseUrl",
                                e.currentTarget.value || undefined,
                              )
                            }
                          />
                        </Field>

                        <div className="w-full">
                          <p className="text-sm text-muted-foreground">
                            Current key
                          </p>
                          <p className="mt-0.5 text-sm">
                            {form.apiKeyMasked
                              ? form.apiKeyMasked
                              : "Not configured"}
                          </p>
                        </div>
                        <Field className="max-w-80">
                          <FieldLabel htmlFor="settings-api-key">
                            New API key
                          </FieldLabel>
                          <Input
                            id="settings-api-key"
                            type="password"
                            placeholder="Paste API key"
                            value={newApiKey}
                            onChange={(e) => {
                              setNewApiKey(e.currentTarget.value);
                              setTestResult(null);
                            }}
                          />
                        </Field>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="xs"
                            variant="secondary"
                            disabled={testConnection.isPending || !keyDirty}
                            onClick={() => handleTestConnection()}
                          >
                            {testConnection.isPending && (
                              <Spinner className="size-3" />
                            )}
                            Test connection
                          </Button>
                          {testResult?.ok && (
                            <Badge variant="success">Connected</Badge>
                          )}
                          {testResult && !testResult.ok && (
                            <Badge variant="destructive">
                              {ERROR_LABELS[testResult.error] ??
                                testResult.error}
                            </Badge>
                          )}
                        </div>
                        {keyUntested && (
                          <p className="text-sm text-muted-foreground">
                            Test connection before you can save this key.
                          </p>
                        )}

                        <Field className="max-w-80">
                          <FieldLabel htmlFor="settings-model">
                            Model
                          </FieldLabel>
                          <Input
                            id="settings-model"
                            list="settings-model-options"
                            value={form.model}
                            onChange={(e) =>
                              setConnectionField("model", e.currentTarget.value)
                            }
                          />
                          <datalist id="settings-model-options">
                            {availableModels.map((m) => (
                              <option key={m} value={m} />
                            ))}
                          </datalist>
                        </Field>

                        <Field className="max-w-28">
                          <FieldLabel htmlFor="settings-max-tokens">
                            Max output tokens
                          </FieldLabel>
                          <Input
                            id="settings-max-tokens"
                            type="number"
                            step={1000}
                            value={form.maxOutputTokens}
                            onChange={(e) =>
                              setField(
                                "maxOutputTokens",
                                numberValue(e.currentTarget.value),
                              )
                            }
                          />
                        </Field>

                        {isAnthropic && (
                          <>
                            <Field className="max-w-80">
                              <FieldLabel htmlFor="settings-thinking">
                                Thinking mode
                              </FieldLabel>
                              <NativeSelect
                                id="settings-thinking"
                                className="w-full"
                                value={form.thinking}
                                onChange={(e) =>
                                  setField(
                                    "thinking",
                                    e.currentTarget
                                      .value as AgentConfig["thinking"],
                                  )
                                }
                              >
                                <NativeSelectOption value="adaptive">
                                  Adaptive (extended thinking)
                                </NativeSelectOption>
                                <NativeSelectOption value="off">
                                  Off
                                </NativeSelectOption>
                              </NativeSelect>
                            </Field>
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={form.promptCaching ?? true}
                                onCheckedChange={(checked) =>
                                  setField("promptCaching", checked === true)
                                }
                              />
                              Prompt caching
                            </label>
                          </>
                        )}

                        {!isAnthropic && (
                          <Field className="max-w-40">
                            <FieldLabel htmlFor="settings-reasoning">
                              Reasoning effort
                            </FieldLabel>
                            <NativeSelect
                              id="settings-reasoning"
                              className="w-full"
                              value={form.reasoningEffort ?? ""}
                              onChange={(e) =>
                                setField(
                                  "reasoningEffort",
                                  (e.currentTarget.value ||
                                    null) as ReasoningEffort | null,
                                )
                              }
                            >
                              <NativeSelectOption value="">
                                Not set
                              </NativeSelectOption>
                              <NativeSelectOption value="low">
                                Low
                              </NativeSelectOption>
                              <NativeSelectOption value="medium">
                                Medium
                              </NativeSelectOption>
                              <NativeSelectOption value="high">
                                High
                              </NativeSelectOption>
                            </NativeSelect>
                          </Field>
                        )}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="loop">
                    {form && (
                      <div className="grid grid-cols-[repeat(2,minmax(0,160px))] gap-x-4 gap-y-3">
                        <Field>
                          <FieldLabel htmlFor="settings-max-retries">
                            Max retries
                          </FieldLabel>
                          <Input
                            id="settings-max-retries"
                            type="number"
                            step={1}
                            value={form.maxRetries}
                            onChange={(e) =>
                              setField(
                                "maxRetries",
                                numberValue(e.currentTarget.value),
                              )
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="settings-request-timeout">
                            Request timeout (ms)
                          </FieldLabel>
                          <Input
                            id="settings-request-timeout"
                            type="number"
                            step={1000}
                            value={form.requestTimeoutMs}
                            onChange={(e) =>
                              setField(
                                "requestTimeoutMs",
                                numberValue(e.currentTarget.value),
                              )
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="settings-hard-timeout">
                            Hard timeout (ms)
                          </FieldLabel>
                          <Input
                            id="settings-hard-timeout"
                            type="number"
                            step={1000}
                            value={form.hardTimeoutMs}
                            onChange={(e) =>
                              setField(
                                "hardTimeoutMs",
                                numberValue(e.currentTarget.value),
                              )
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="settings-tool-timeout">
                            Tool timeout (ms)
                          </FieldLabel>
                          <Input
                            id="settings-tool-timeout"
                            type="number"
                            step={1000}
                            value={form.toolTimeoutMs}
                            onChange={(e) =>
                              setField(
                                "toolTimeoutMs",
                                numberValue(e.currentTarget.value),
                              )
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="settings-code-budget">
                            Code session budget (ms)
                          </FieldLabel>
                          <Input
                            id="settings-code-budget"
                            type="number"
                            step={60000}
                            value={form.codeSessionBudgetMs}
                            onChange={(e) =>
                              setField(
                                "codeSessionBudgetMs",
                                numberValue(e.currentTarget.value),
                              )
                            }
                          />
                        </Field>
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="sandbox">
                    {form && (
                      <div className="flex flex-col gap-3">
                        <div className="grid grid-cols-[repeat(2,minmax(0,160px))] gap-x-4 gap-y-3">
                          <Field>
                            <FieldLabel htmlFor="settings-sandbox-idle">
                              Idle cleanup (ms)
                            </FieldLabel>
                            <Input
                              id="settings-sandbox-idle"
                              type="number"
                              step={60000}
                              value={form.sandboxIdleTimeoutMs}
                              onChange={(e) =>
                                setField(
                                  "sandboxIdleTimeoutMs",
                                  numberValue(e.currentTarget.value),
                                )
                              }
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="settings-sandbox-cpus">
                              CPU limit (cores)
                            </FieldLabel>
                            <Input
                              id="settings-sandbox-cpus"
                              type="number"
                              step={1}
                              value={form.sandboxCpus}
                              onChange={(e) =>
                                setField(
                                  "sandboxCpus",
                                  numberValue(e.currentTarget.value),
                                )
                              }
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="settings-sandbox-memory">
                              Memory limit (MB)
                            </FieldLabel>
                            <Input
                              id="settings-sandbox-memory"
                              type="number"
                              step={256}
                              value={form.sandboxMemoryMb}
                              onChange={(e) =>
                                setField(
                                  "sandboxMemoryMb",
                                  numberValue(e.currentTarget.value),
                                )
                              }
                            />
                          </Field>
                        </div>
                        <label className="flex items-start gap-2 text-sm">
                          <Checkbox
                            className="mt-0.5"
                            checked={form.sandboxRequireGvisor === true}
                            onCheckedChange={(checked) =>
                              setField("sandboxRequireGvisor", checked === true)
                            }
                          />
                          <span>
                            Require gVisor
                            <span className="block text-muted-foreground">
                              Refuse to start a sandbox unless the Docker host
                              provides the gVisor (runsc) runtime. Off by
                              default: gVisor is used automatically when
                              present.
                            </span>
                          </span>
                        </label>
                        <div className="mt-2 flex flex-col gap-3">
                          <Field className="max-w-52">
                            <FieldLabel htmlFor="settings-sandbox-network">
                              Agent network
                            </FieldLabel>
                            <NativeSelect
                              id="settings-sandbox-network"
                              value={form.sandboxNetwork}
                              onChange={(e) =>
                                setField(
                                  "sandboxNetwork",
                                  e.currentTarget.value === "open"
                                    ? "open"
                                    : e.currentTarget.value === "none"
                                      ? "none"
                                      : "allowlist",
                                )
                              }
                            >
                              <NativeSelectOption value="allowlist">
                                Allowlist (recommended)
                              </NativeSelectOption>
                              <NativeSelectOption value="open">
                                Open (unrestricted)
                              </NativeSelectOption>
                              <NativeSelectOption value="none">
                                None (no network)
                              </NativeSelectOption>
                            </NativeSelect>
                          </Field>
                          <p className="text-sm text-muted-foreground">
                            {form.sandboxNetwork === "allowlist"
                              ? "All sandbox traffic is forced through an enforcing proxy that reaches only the hosts below. The agent installs dependencies itself."
                              : form.sandboxNetwork === "none"
                                ? "The sandbox gets no network at all: read/edit sessions only - dependencies can never install, so tests will not run."
                                : "The agent keeps full internet access for the whole session. A prompt-injected agent could exfiltrate repository content."}
                          </p>
                          {form.sandboxNetwork === "allowlist" && (
                            <Field>
                              <FieldLabel htmlFor="settings-sandbox-allowlist">
                                Allowed hosts (one per line)
                              </FieldLabel>
                              <textarea
                                id="settings-sandbox-allowlist"
                                className="min-h-24 w-full max-w-96 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm"
                                value={form.sandboxAllowlistHosts.join("\n")}
                                onChange={(e) =>
                                  setField(
                                    "sandboxAllowlistHosts",
                                    e.currentTarget.value.split("\n"),
                                  )
                                }
                              />
                            </Field>
                          )}
                        </div>
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="account">
                    <div>
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => void logoutAll()}
                      >
                        Log out all devices
                      </Button>
                    </div>
                  </TabsContent>
                </div>
              </ScrollArea>

              <div className="flex justify-end gap-2 px-6 py-2">
                <Button
                  type="submit"
                  disabled={
                    !dirty ||
                    keyUntested ||
                    saveConfig.isPending ||
                    saveApiKey.isPending
                  }
                >
                  {(saveConfig.isPending || saveApiKey.isPending) && (
                    <Spinner className="size-4" />
                  )}
                  Save
                </Button>
              </div>
            </form>
          </div>
        </Tabs>
      </DialogContent>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={(o) => {
          if (!o) setConfirmDiscard(false);
        }}
        title="Discard unsaved changes?"
        description="Your edits will be lost and the form will reset to the saved values."
        confirmLabel="Discard"
        destructive
        onConfirm={confirmDiscardEdits}
      />
    </Dialog>
  );
}
