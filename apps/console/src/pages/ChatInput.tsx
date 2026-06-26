import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, Textarea } from "@mantine/core";
import { Square } from "lucide-react";

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

  async function handleSubmit(): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;

    if (pendingInterrupt) {
      if (sessionId === null) return;

      await fetch(`/api/sessions/${sessionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, resolvedBy: "console" }),
      });
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

  async function handleStop(): Promise<void> {
    if (sessionId === null) return;
    await fetch(`/api/sessions/${sessionId}/stop`, { method: "POST" });
  }

  function placeholder(): string {
    if (isRunning) return "Agent is running…";
    if (pendingInterrupt?.kind === "approval") return "Add context…";
    if (pendingInterrupt?.kind === "clarification") return "Type your answer…";
    if (pendingInterrupt?.kind === "continue") return "Use the controls above to resume or end…";
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
        disabled={isRunning || pendingInterrupt?.kind === "continue"}
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
      {isRunning ? (
        <Button
          color="red"
          variant="light"
          onClick={() => void handleStop()}
          size="sm"
          leftSection={<Square {...STOP_ICON_PROPS} />}
        >
          Stop
        </Button>
      ) : (
        <Button onClick={() => void handleSubmit()} size="sm">
          Send
        </Button>
      )}
    </div>
  );
}
