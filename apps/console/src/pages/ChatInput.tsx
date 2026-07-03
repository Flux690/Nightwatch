import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, Square } from "lucide-react";
import { toast } from "../ui/Toast.js";
import { apiFetch } from "../api/client.js";

const MAX_TEXTAREA_HEIGHT = 200;
const ICON_PROPS = { size: 16, strokeWidth: 2, "aria-hidden": true } as const;

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

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);

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
    <div className="composer">
      <label htmlFor="composer-textarea" className="sr-only">
        Message
      </label>
      <div className="composer__container">
        <textarea
          ref={textareaRef}
          id="composer-textarea"
          className="composer__textarea"
          placeholder={isRunning ? "Agent is running…" : "Type a message…"}
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
          rows={1}
        />
        <div className="composer__action">
          {isRunning ? (
            <button
              type="button"
              className="composer__send"
              data-stop=""
              aria-label="Stop generating"
              onClick={() => sessionId !== null && stop.mutate()}
              disabled={stop.isPending}
            >
              <Square {...ICON_PROPS} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__send"
              aria-label="Send message"
              onClick={handleSubmit}
              disabled={!canSend}
            >
              <ArrowUp {...ICON_PROPS} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
