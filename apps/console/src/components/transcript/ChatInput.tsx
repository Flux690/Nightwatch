import { useCallback, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, Square } from "lucide-react";
import type { RunMode } from "@nightwatch/shared";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ICON_UI } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

export interface ChatInputProps {
  sessionId: string | null;
  isRunning: boolean;
  disabled?: boolean;
  // Hides the mode picker: an investigation can never demote (one-way ratchet),
  // so the composer has nothing to choose.
  investigation?: boolean;
  onSessionCreated?: (
    sessionId: string,
    firstMessage: string,
    mode: RunMode,
  ) => void;
  onSend?: (text: string, mode: RunMode) => void;
  // The POST never reached the API: the view rolls back its optimistic state.
  onSendFailed?: () => void;
}

/* Ask | Investigate segmented picker. On an existing conversation, choosing
   Investigate escalates it on the next send. */
function ModePicker({
  mode,
  onChange,
  disabled,
}: {
  mode: RunMode;
  onChange: (mode: RunMode) => void;
  disabled: boolean;
}): React.JSX.Element {
  const options: { value: RunMode; label: string }[] = [
    { value: "ask", label: "Ask" },
    { value: "investigate", label: "Investigate" },
  ];
  return (
    <div
      role="group"
      aria-label="Session mode"
      className="flex items-center gap-0.5 rounded-full bg-surface p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={mode === opt.value}
          disabled={disabled}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
            mode === opt.value
              ? "bg-card text-foreground shadow-raised"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function ChatInput({
  sessionId,
  isRunning,
  disabled,
  investigation = false,
  onSessionCreated,
  onSend,
  onSendFailed,
}: ChatInputProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<RunMode>("ask");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const navigate = useNavigate();

  const submit = useMutation({
    mutationFn: async (trimmed: string): Promise<string | null> => {
      if (sessionId === null) {
        const data = await apiFetch<{ sessionId: string }>("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, mode }),
        });
        onSessionCreated?.(data.sessionId, trimmed, mode);
        return data.sessionId;
      }
      // Only escalation is sent; otherwise the server derives the mode
      // (one-way ratchet - a follow-up can never demote an investigation).
      await apiFetch<void>(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          ...(mode === "investigate" &&
            !investigation && { mode: "investigate" as const }),
        }),
      });
      return null;
    },
    onSuccess: async (createdSessionId) => {
      if (createdSessionId !== null) {
        await navigate({
          to: "/sessions/$id",
          params: { id: createdSessionId },
          replace: true,
        });
      }
      textareaRef.current?.focus();
    },
    onError: (err, failedText) => {
      // Restore the message unless the user already typed something new.
      setText((current) => (current === "" ? failedText : current));
      onSendFailed?.();
      toast.show({
        title: "Message not sent",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const stop = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/sessions/${sessionId}/stop`, { method: "POST" }),
    onError: (err) => {
      toast.show({
        title: "Could not stop the run",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isRunning || disabled || submit.isPending) return;
    // Cleared at submit, not on success: the echoed bubble is the message now.
    setText("");
    onSend?.(trimmed, mode);
    submit.mutate(trimmed);
  }, [text, isRunning, disabled, submit, onSend, mode]);

  const canSend =
    text.trim().length > 0 && !isRunning && !disabled && !submit.isPending;
  const inputDisabled = isRunning || !!disabled;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter") return;
      if (e.shiftKey || composingRef.current) return;
      if (window.matchMedia("(pointer: coarse)").matches) return;
      e.preventDefault();
      handleSubmit();
    },
    [handleSubmit],
  );

  return (
    <div className="mx-auto w-full max-w-chat px-6 pb-4 pt-2 max-md:px-3 max-md:pb-3">
      <Label htmlFor="composer-textarea" className="sr-only">
        Message
      </Label>
      <InputGroup className="rounded-2xl bg-card shadow-raised">
        <InputGroupTextarea
          ref={textareaRef}
          id="composer-textarea"
          className="max-h-[200px] px-4 py-3"
          placeholder={isRunning ? "Agent is running…" : "Write a message…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          disabled={inputDisabled}
          rows={3}
        />
        <InputGroupAddon
          align="block-end"
          className="justify-between gap-2 px-2 pb-2"
        >
          {investigation ? (
            <span />
          ) : (
            <ModePicker
              mode={mode}
              onChange={setMode}
              disabled={inputDisabled}
            />
          )}
          {isRunning ? (
            <InputGroupButton
              type="button"
              variant="default"
              size="icon-sm"
              className="rounded-full"
              aria-label="Stop generating"
              onClick={() => sessionId !== null && stop.mutate()}
              disabled={stop.isPending}
            >
              <Square {...ICON_UI} />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="button"
              variant="default"
              size="icon-sm"
              className="rounded-full"
              aria-label="Send message"
              onClick={handleSubmit}
              disabled={!canSend}
            >
              <ArrowUp {...ICON_UI} />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
