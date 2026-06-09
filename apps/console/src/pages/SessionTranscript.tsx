import { useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Text } from "@mantine/core";
import { useCallback, useState } from "react";
import type {
  ConsoleToolCall,
  InstallationRecord,
  SessionMessage,
  WsEnvelope,
} from "@nightwatch/shared";
import { useConsoleWs } from "../hooks/useConsoleWs.js";
import { ChatInput } from "./ChatInput.js";

interface LiveTextItem {
  kind: "text";
  id: string;
  text: string;
}

interface LiveToolCard {
  kind: "tool_card";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: unknown | null;
}

type LiveItem = LiveTextItem | LiveToolCard;

function ToolCard({ card }: { card: LiveToolCard }): React.JSX.Element {
  const inputText = JSON.stringify(card.input, null, 2);

  return (
    <div style={{ marginBottom: "var(--mantine-spacing-sm)" }}>
      <Text size="xs" ff="monospace" fw={600} mb={4}>
        {card.toolName}
      </Text>
      <div
        style={{
          border: "1px solid var(--mantine-color-dark-4)",
          borderRadius: "var(--mantine-radius-sm)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "var(--mantine-spacing-xs)" }}>
          <Text size="xs" c="dimmed" ff="monospace" mb={4}>
            IN
          </Text>
          <pre
            style={{
              margin: 0,
              fontFamily: "var(--nw-mono)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {inputText}
          </pre>
        </div>
        <div style={{ borderTop: "1px solid var(--mantine-color-dark-4)" }} />
        <div style={{ padding: "var(--mantine-spacing-xs)" }}>
          <Text size="xs" c="dimmed" ff="monospace" mb={4}>
            OUT
          </Text>
          {card.result === null ? (
            <Text
              size="xs"
              c="dimmed"
              ff="monospace"
              data-testid="tool-card-out-loading"
            >
              …
            </Text>
          ) : (
            <pre
              style={{
                margin: 0,
                fontFamily: "var(--nw-mono)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {JSON.stringify(card.result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function SessionTranscript(): React.JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const queryClient = useQueryClient();
  const [liveItems, setLiveItems] = useState<LiveItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const { data: installations } = useQuery<InstallationRecord[]>({
    queryKey: ["installations"],
    queryFn: () =>
      fetch("/api/installations").then((r) => {
        if (!r.ok) throw new Error(`installations ${r.status}`);
        return r.json() as Promise<InstallationRecord[]>;
      }),
  });

  const token = installations?.[0]?.token;

  const { data: messages = [] } = useQuery<SessionMessage[]>({
    queryKey: ["session", id],
    queryFn: () =>
      fetch(`/api/sessions/${id}?token=${token}`).then((r) => {
        if (!r.ok) throw new Error(`sessions/${id} ${r.status}`);
        return r.json() as Promise<SessionMessage[]>;
      }),
    enabled: !!token,
  });

  const handleEnvelope = useCallback(
    (env: WsEnvelope) => {
      if (env.type === "session_delta") {
        const { sessionId, delta } = env.payload as {
          sessionId: string;
          delta: string;
          kind: string;
        };
        if (sessionId !== id) return;
        setIsRunning(true);
        setLiveItems((prev) => {
          const last = prev[prev.length - 1];
          if (last?.kind === "text") {
            return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
          }
          return [
            ...prev,
            { kind: "text", id: `text-${Date.now()}`, text: delta },
          ];
        });
      } else if (env.type === "session_message") {
        const { sessionId, message } = env.payload as {
          sessionId: string;
          message: SessionMessage;
        };
        if (sessionId !== id) return;
        setIsRunning(false);
        setLiveItems([]);
        queryClient.setQueryData<SessionMessage[]>(
          ["session", id],
          (prev = []) => [...prev, message],
        );
      } else if (env.type === "tool_call") {
        const payload = env.payload as ConsoleToolCall["payload"];
        if (payload.sessionId !== id) return;
        if (payload.phase === "start") {
          setLiveItems((prev) => [
            ...prev,
            {
              kind: "tool_card",
              toolUseId: payload.toolUseId,
              toolName: payload.toolName,
              input: payload.input ?? {},
              result: null,
            },
          ]);
        } else if (payload.phase === "result") {
          setLiveItems((prev) =>
            prev.map((item) =>
              item.kind === "tool_card" && item.toolUseId === payload.toolUseId
                ? { ...item, result: payload.result ?? null }
                : item,
            ),
          );
        }
      }
    },
    [id, queryClient],
  );

  useConsoleWs(handleEnvelope);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <div
        style={{
          flex: 1,
          padding: "var(--mantine-spacing-md)",
          overflowY: "auto",
        }}
      >
        {messages.map((msg) => (
          <div
            key={msg.seq}
            style={{ marginBottom: "var(--mantine-spacing-sm)" }}
          >
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {msg.content}
            </Text>
          </div>
        ))}

        {liveItems.map((item) => {
          if (item.kind === "text") {
            return (
              <div
                key={item.id}
                style={{ marginBottom: "var(--mantine-spacing-sm)" }}
              >
                <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                  {item.text}
                </Text>
              </div>
            );
          }
          return <ToolCard key={item.toolUseId} card={item} />;
        })}
      </div>

      <ChatInput token={token ?? ""} sessionId={id} isRunning={isRunning} />
    </div>
  );
}
