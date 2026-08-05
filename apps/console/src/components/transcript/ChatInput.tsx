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
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

export interface ChatInputProps {
  sessionId: string | null;
  isRunning: boolean;
  onSessionCreated?: (sessionId: string, firstMessage: string) => void;
  onSend?: (text: string) => void;
  // The POST never reached the API: the view rolls back its optimistic state.
  onSendFailed?: () => void;
}

export function ChatInput({
  sessionId,
  isRunning,
  onSessionCreated,
  onSend,
  onSendFailed,
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
    if (!trimmed || isRunning || submit.isPending) return;
    // Cleared at submit, not on success: the echoed bubble is the message now.
    setText("");
    onSend?.(trimmed);
    submit.mutate(trimmed);
  }, [text, isRunning, submit, onSend]);

  const canSend = text.trim().length > 0 && !isRunning && !submit.isPending;

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
      <Label htmlFor="chat-textarea" className="sr-only">
        Message
      </Label>
      {/* A rung above the sidebar on the surface ladder, which is what reads as
          a control without a border. Held through every state: focus is the
          only thing that colours the edge. */}
      <InputGroup className="edge-lit rounded-2xl border-transparent bg-secondary shadow-edge has-disabled:bg-secondary has-disabled:opacity-100">
        <InputGroupTextarea
          ref={textareaRef}
          id="chat-textarea"
          className="max-h-[200px] px-4 py-3 placeholder:text-ink-subtle"
          placeholder={isRunning ? "Agent is running…" : "Ask NightWarden…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          disabled={isRunning}
          rows={3}
        />
        <InputGroupAddon
          align="block-end"
          className="justify-between gap-2 px-2 pb-2"
        >
          {/* Holds the send button against the trailing edge now that nothing
              occupies the leading one. */}
          <span />
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
              <Square size={16} strokeWidth={2.25} aria-hidden />
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
              <ArrowUp size={16} strokeWidth={2.25} aria-hidden />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
