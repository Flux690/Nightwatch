import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Square } from "lucide-react";
import { Button } from "../ui/Button.js";
import { Textarea } from "../ui/Textarea.js";
import { toast } from "../ui/Toast.js";
import { apiFetch } from "../api/client.js";

const STOP_ICON_PROPS = {
  size: 14,
  strokeWidth: 1.5,
  "aria-hidden": true,
} as const;

export interface PendingInterrupt {
  id: string;
  kind: "approval" | "clarification" | "continue";
}

export interface ChatInputProps {
  sessionId: string | null;
  isRunning: boolean;
  pendingInterrupt?: PendingInterrupt;
  onSessionCreated?: (sessionId: string, firstMessage: string) => void;
}

export function ChatInput({
  sessionId,
  isRunning,
  pendingInterrupt,
  onSessionCreated,
}: ChatInputProps): React.JSX.Element {
  const [text, setText] = useState("");
  const navigate = useNavigate();

  const submit = useMutation({
    mutationFn: async (trimmed: string): Promise<string | null> => {
      if (pendingInterrupt) {
        if (sessionId === null) return null;
        await apiFetch<void>(`/api/sessions/${sessionId}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed, resolvedBy: "console" }),
        });
        return null;
      }
      if (sessionId === null) {
        const data = await apiFetch<{ sessionId: string }>(`/api/chat`, {
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
    },
    onError: (err) => {
      toast.show({
        title: "Message not sent",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  function handleSubmit(): void {
    const trimmed = text.trim();
    if (!trimmed || isRunning || submit.isPending) return;
    submit.mutate(trimmed);
  }

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

  function placeholder(): string {
    if (isRunning) return "Agent is running…";
    if (pendingInterrupt?.kind === "approval") return "Add context…";
    if (pendingInterrupt?.kind === "clarification") return "Type your answer…";
    if (pendingInterrupt?.kind === "continue")
      return "Use the controls above to resume or end…";
    return "Type a message…";
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--color-line)",
        background: "var(--color-surface)",
        padding: 8,
        display: "flex",
        gap: 4,
        alignItems: "flex-end",
      }}
    >
      <Textarea
        style={{ flex: 1 }}
        placeholder={placeholder()}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        disabled={isRunning || pendingInterrupt?.kind === "continue"}
        autosize
        minRows={1}
        maxRows={6}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      />
      {isRunning ? (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => sessionId !== null && stop.mutate()}
          loading={stop.isPending}
          leftSection={<Square {...STOP_ICON_PROPS} />}
        >
          Stop
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => handleSubmit()}
          loading={submit.isPending}
          disabled={submit.isPending}
        >
          Send
        </Button>
      )}
    </div>
  );
}
