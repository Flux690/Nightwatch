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
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ICON_UI } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { IngestCredentialSection } from "./IngestCredentialSection.js";
import { useAuth } from "@/auth/AuthContext";

type TestResult =
  | { ok: true }
  | { ok: false; error: "bad_key" | "unreachable" | "unknown_model" };

const ERROR_LABELS: Record<string, string> = {
  bad_key: "Invalid API key",
  unreachable: "Endpoint unreachable",
  unknown_model: "Model not found on endpoint",
};

type SectionId =
  | "model"
  | "api-key"
  | "loop"
  | "sandbox"
  | "alerting"
  | "account";

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
    id: "sandbox",
    label: "Sandbox",
    description:
      "Lifecycle and resource limits for per-session code sandboxes.",
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

// Hosts the sandbox egress proxy recently refused, offered as one-click adds
// so a legitimately-needed host is a click, not a cryptic install failure.
// Only hosts not already listed are shown.
function EgressDenials({
  allowlist,
  onAdd,
}: {
  allowlist: string[];
  onAdd: (host: string) => void;
}): React.JSX.Element | null {
  const { data } = useQuery<{ hosts: string[] }>({
    queryKey: ["egress-denials"],
    queryFn: () =>
      apiFetch<{ hosts: string[] }>("/api/config/sandbox/egress-denials"),
    refetchInterval: 15_000,
  });
  const pending = (data?.hosts ?? []).filter((h) => !allowlist.includes(h));
  if (pending.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">Recently blocked</p>
      <div className="flex flex-wrap gap-2">
        {pending.map((host) => (
          <button
            key={host}
            type="button"
            onClick={() => onAdd(host)}
            className="inline-flex items-center gap-1 rounded-sm bg-warning-tint px-2 py-1 font-mono text-xs text-warning hover:bg-warning-tint/70"
          >
            {host}
            <span aria-hidden className="font-semibold">
              + Add
            </span>
          </button>
        ))}
      </div>
    </div>
  );
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
    // The allowlist textarea keeps blank lines while editing; drop them (and
    // trim) before diffing so an empty entry never reaches the API.
    const cleaned: AgentConfig = {
      ...form,
      sandboxEgressAllowlist: form.sandboxEgressAllowlist
        .map((h) => h.trim())
        .filter(Boolean),
    };
    const delta = buildDelta(cleaned, config);
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
          Configure the investigation agent, API key, loop budgets, alerting and
          account.
        </DialogDescription>

        <Tabs
          orientation="vertical"
          value={section}
          onValueChange={(v) => setSection(v as SectionId)}
          className="grid h-[min(640px,85vh)] grid-cols-1 grid-rows-[auto_1fr] gap-0 sm:grid-cols-[210px_minmax(0,1fr)] sm:grid-rows-none"
        >
          <div className="flex flex-col border-b border-border bg-surface p-2 max-sm:flex-row max-sm:overflow-x-auto sm:border-b-0 sm:border-r sm:px-2 sm:py-4">
            <h2 className="mb-3 px-2.5 text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground max-sm:hidden">
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
                  className="justify-start rounded-md bg-transparent px-2.5 py-2 text-muted-foreground hover:bg-surface-hover hover:text-foreground data-active:bg-surface-active data-active:text-foreground data-active:hover:bg-surface-active max-sm:w-auto max-sm:whitespace-nowrap after:hidden"
                >
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="relative flex min-w-0 flex-col bg-card">
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
              <ScrollArea className="flex-1">
                <div className="p-6">
                  <h3 className="mb-1 text-lg font-semibold tracking-[-0.2px] text-foreground">
                    {active.label}
                  </h3>
                  <p className="mb-5 text-xs text-muted-foreground">
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
                              setField(
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
                              setField(
                                "baseUrl",
                                e.currentTarget.value || undefined,
                              )
                            }
                          />
                        </Field>

                        <Field className="max-w-80">
                          <FieldLabel htmlFor="settings-model">
                            Model
                          </FieldLabel>
                          <Input
                            id="settings-model"
                            list="settings-model-options"
                            value={form.model}
                            onChange={(e) =>
                              setField("model", e.currentTarget.value)
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

                  <TabsContent value="api-key">
                    {form && (
                      <div className="flex flex-col items-start gap-4 [&>*]:w-full">
                        <div>
                          <p className="text-xs text-muted-foreground">
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
                            disabled={testConnection.isPending}
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
                        <label className="col-span-2 flex items-start gap-2 text-sm">
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
                        <div className="col-span-2 mt-2 flex flex-col gap-3 border-t border-border pt-4">
                          <Field className="max-w-52">
                            <FieldLabel htmlFor="settings-egress-policy">
                              Network egress
                            </FieldLabel>
                            <NativeSelect
                              id="settings-egress-policy"
                              value={form.sandboxEgressPolicy}
                              onChange={(e) =>
                                setField(
                                  "sandboxEgressPolicy",
                                  e.currentTarget.value === "open"
                                    ? "open"
                                    : "allowlist",
                                )
                              }
                            >
                              <NativeSelectOption value="allowlist">
                                Allowlist (deny by default)
                              </NativeSelectOption>
                              <NativeSelectOption value="open">
                                Open (unrestricted)
                              </NativeSelectOption>
                            </NativeSelect>
                          </Field>
                          {form.sandboxEgressPolicy === "allowlist" && (
                            <>
                              <Field>
                                <FieldLabel htmlFor="settings-egress-allowlist">
                                  Allowed hosts (one per line; subdomains
                                  included)
                                </FieldLabel>
                                <Textarea
                                  id="settings-egress-allowlist"
                                  rows={6}
                                  className="font-mono text-sm"
                                  value={form.sandboxEgressAllowlist.join("\n")}
                                  onChange={(e) =>
                                    setField(
                                      "sandboxEgressAllowlist",
                                      e.currentTarget.value.split("\n"),
                                    )
                                  }
                                />
                              </Field>
                              <EgressDenials
                                allowlist={form.sandboxEgressAllowlist}
                                onAdd={(host) =>
                                  setField("sandboxEgressAllowlist", [
                                    ...form.sandboxEgressAllowlist,
                                    host,
                                  ])
                                }
                              />
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="alerting">
                    <IngestCredentialSection />
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

              <div className="flex justify-end gap-2 border-t border-border bg-card px-6 py-3">
                <Button type="submit" disabled={!dirty || saveConfig.isPending}>
                  {saveConfig.isPending && <Spinner className="size-4" />}
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
