import { useState } from "react";
import { Pencil } from "lucide-react";
import type {
  AgentConfig,
  ModelOption,
  ProviderOption,
  ProviderSettings,
} from "@nightwarden/shared";

import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ICON_UI } from "@/lib/iconProps";
import { Spinner } from "@/components/ui/spinner";
import { SettingsGroup, SettingsRow } from "./SettingsRow";
import { CONTROL } from "./layout";

/* What the user did themselves. "input-clear" is absent on purpose: that is
   Base UI wiping the box when the list closes on no match, and honouring it is
   what threw away what had just been typed. */
const OPERATOR_EDIT = new Set([
  "input-change",
  "input-paste",
  "item-press",
  "clear-press",
]);

export type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; models: ModelOption[] }
  | { kind: "empty"; message: string };

interface ProviderSectionProps {
  form: AgentConfig;
  block: ProviderSettings | null;
  savedApiKeyMasked: string | null;
  catalog: CatalogState;
  providers: ProviderOption[];
  newApiKey: string;
  dirty: boolean;
  saving: boolean;
  unchosen: boolean;
  onProviderChange: (provider: AgentConfig["provider"]) => void;
  onProviderField: <K extends keyof ProviderSettings>(
    key: K,
    value: ProviderSettings[K],
  ) => void;
  onModelChange: (id: string | null) => void;
  onApiKeyChange: (key: string) => void;
  onSave: () => void;
}

/* The one block that is not autosaved: a provider with no key and no model
   cannot run an investigation, so the five fields are one transaction and the
   Save button belongs to them rather than to the page. */
export function ProviderSection({
  form,
  block,
  savedApiKeyMasked,
  catalog,
  providers,
  newApiKey,
  dirty,
  saving,
  unchosen,
  onProviderChange,
  onProviderField,
  onModelChange,
  onApiKeyChange,
  onSave,
}: ProviderSectionProps): React.JSX.Element {
  const [replacingKey, setReplacingKey] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const keyInputOpen = savedApiKeyMasked === null || replacingKey;
  const reasoning = block?.model ? (block.reasoning ?? null) : null;
  const models = catalog.kind === "ready" ? catalog.models : [];
  const providerItems: Record<string, string> = {
    "": "Select a provider",
    ...Object.fromEntries(
      providers.map((provider) => [provider.name, provider.label]),
    ),
  };
  const levelItems: Record<string, string> = {
    ...(reasoning?.canDisable === true ? { "": "Off" } : {}),
    ...Object.fromEntries(
      (reasoning?.levels ?? []).map((l) => [l.value, l.label]),
    ),
  };

  return (
    <div className="flex flex-col gap-3">
      <SettingsGroup>
        <SettingsRow
          controlId="settings-provider"
          title="Provider"
          description="Which service answers a request."
        >
          <Select
            items={providerItems}
            value={form.provider ?? ""}
            onValueChange={(value) =>
              onProviderChange((value || null) as AgentConfig["provider"])
            }
          >
            <SelectTrigger id="settings-provider" className={CONTROL.select}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(providerItems).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow
          controlId="settings-base-url"
          title="Base URL"
          description="Where to reach that service."
        >
          <Input
            id="settings-base-url"
            className={CONTROL.text}
            disabled={block === null}
            placeholder={
              providers.find((p) => p.name === form.provider)?.defaultBaseUrl ??
              ""
            }
            value={block?.baseUrl ?? ""}
            onChange={(e) =>
              onProviderField("baseUrl", e.currentTarget.value || undefined)
            }
          />
        </SettingsRow>

        <SettingsRow
          controlId="settings-api-key"
          title="API key"
          description="Stored encrypted and never shown again."
        >
          {keyInputOpen ? (
            <Input
              id="settings-api-key"
              type="password"
              className={CONTROL.text}
              disabled={block === null}
              placeholder="Paste API key"
              value={newApiKey}
              onChange={(e) => onApiKeyChange(e.currentTarget.value)}
            />
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">
                {savedApiKeyMasked}
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Replace API key"
                onClick={() => setReplacingKey(true)}
              >
                <Pencil {...ICON_UI} />
              </Button>
            </div>
          )}
        </SettingsRow>

        <SettingsRow
          controlId="settings-model"
          title="Model"
          description="Picked from what that endpoint lists."
        >
          <Combobox
            items={models.map((m) => m.id)}
            value={block?.model ?? ""}
            inputValue={typed ?? block?.model ?? ""}
            /* What is in the box is the answer and it stays there: Base UI would
               otherwise put the saved id back the moment the list closed. */
            onInputValueChange={(text, details) => {
              if (!OPERATOR_EDIT.has(details.reason)) return;
              setTyped(text);
              onModelChange(models.some((m) => m.id === text) ? text : null);
            }}
            openOnInputClick
          >
            <ComboboxInput
              id="settings-model"
              aria-label="Model"
              className={CONTROL.text}
              onKeyDownCapture={(e) => {
                if (e.key !== "Enter") return;
                if (document.querySelector('[role="option"][data-highlighted]'))
                  return;
                e.preventDefault();
                e.stopPropagation();
              }}
              disabled={block === null}
              placeholder={
                block === null ? "Choose a provider first" : "Search models"
              }
            />
            <ComboboxContent
              side="bottom"
              collisionAvoidance={{ side: "none" }}
            >
              <ComboboxEmpty>{emptyMessage(catalog)}</ComboboxEmpty>
              <ComboboxList>
                {(id: string) => (
                  <ComboboxItem key={id} value={id}>
                    <span className="min-w-0 truncate font-mono">{id}</span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </SettingsRow>

        {reasoning && (
          <SettingsRow
            controlId="settings-reasoning"
            title={reasoning.label}
            description="How hard the model works on each request."
          >
            <Select
              items={levelItems}
              value={block?.reasoningLevel ?? ""}
              onValueChange={(value) =>
                onProviderField("reasoningLevel", value || null)
              }
            >
              <SelectTrigger id="settings-reasoning" className={CONTROL.select}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(levelItems).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        )}
      </SettingsGroup>

      <div className="flex justify-end">
        <Button
          type="button"
          disabled={!dirty || unchosen || saving}
          onClick={onSave}
        >
          {saving && <Spinner className="size-4" />}
          Save
        </Button>
      </div>
    </div>
  );
}

function emptyMessage(catalog: CatalogState): string {
  if (catalog.kind === "loading") return "Loading models…";
  if (catalog.kind === "empty") return catalog.message;
  return "No model matches.";
}
