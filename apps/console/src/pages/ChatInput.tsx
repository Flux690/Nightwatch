import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, Textarea } from "@mantine/core";

export interface PendingInterrupt {
  id: string;
  kind: "approval" | "clarification";
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

  async function handleSubmit(): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;

    if (pendingInterrupt) {
      if (sessionId === null) return;

      const { kind } = pendingInterrupt;
      if (kind === "approval") {
        await fetch(`/api/sessions/${sessionId}/add-context`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contextMessage: trimmed,
            resolvedBy: "console",
          }),
        });
      } else {
        await fetch(`/api/sessions/${sessionId}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: trimmed, resolvedBy: "console" }),
        });
      }
      setText("");
      return;
    }

    if (sessionId === null) {
      const res = await fetch(`/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      const data = (await res.json()) as { sessionId: string };
      // Signal before navigation so callers can set up WS filtering immediately.
      onSessionCreated?.(data.sessionId, trimmed);
      await navigate({
        to: "/sessions/$id",
        params: { id: data.sessionId },
        replace: true,
      });
    } else {
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
    }

    setText("");
  }

  function placeholder(): string {
    if (isRunning) return "Agent is running…";
    if (pendingInterrupt?.kind === "approval") return "Add context…";
    if (pendingInterrupt?.kind === "clarification") return "Type your answer…";
    return "Type a message…";
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--nw-border)",
        background: "var(--nw-surface)",
        padding: "var(--mantine-spacing-sm)",
        display: "flex",
        gap: "var(--mantine-spacing-xs)",
        alignItems: "flex-end",
      }}
    >
      <Textarea
        style={{ flex: 1 }}
        placeholder={placeholder()}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        disabled={isRunning}
        autosize
        minRows={1}
        maxRows={6}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
      />
      <Button
        disabled={isRunning}
        onClick={() => void handleSubmit()}
        size="sm"
      >
        Send
      </Button>
    </div>
  );
}
