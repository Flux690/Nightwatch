import { useCallback, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, Square } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { ICON_UI } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

export interface ChatInputProps {
  sessionId: string | null;
  isRunning: boolean;
  disabled?: boolean;
  onSessionCreated?: (sessionId: string, firstMessage: string) => void;
}

export function ChatInput({
  sessionId,
  isRunning,
  disabled,
  onSessionCreated,
}: ChatInputProps): React.JSX.Element {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const navigate = useNavigate();

  const submit = useMutation({
    mutationFn: async (trimmed: string): Promise<string | null> => {
      if (sessionId === null) {
        const data = await apiFetch<{ sessionId: string }>("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed }),
        });
        onSessionCreated?.(data.sessionId, trimmed);
        return data.sessionId;
      }
      await apiFetch<void>(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      return null;
    },
    onSuccess: async (createdSessionId) => {
      setText("");
      if (createdSessionId !== null) {
        await navigate({
          to: "/sessions/$id",
          params: { id: createdSessionId },
          replace: true,
        });
      }
      textareaRef.current?.focus();
    },
    onError: (err) => {
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
    submit.mutate(trimmed);
  }, [text, isRunning, disabled, submit]);

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
        <InputGroupAddon align="block-end" className="justify-end px-2 pb-2">
          {isRunning ? (
            <InputGroupButton
              type="button"
              variant="default"
              size="icon-sm"
              className="rounded-full"
              data-stop=""
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
