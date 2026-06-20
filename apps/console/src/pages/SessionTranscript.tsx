import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Text } from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionMeta,
  SessionMessage,
  WsEnvelope,
} from "@nightwatch/shared";
import { useConsoleWs } from "../hooks/useConsoleWs.js";
import { ChatInput } from "./ChatInput.js";
import type { PendingInterrupt } from "./ChatInput.js";
import { applyLiveEvent } from "../transcript/liveConverter.js";
import { convertPersistedMessages } from "../transcript/persistedConverter.js";
import { TranscriptItemRenderer } from "../transcript/TranscriptItemRenderer.js";
import type { TranscriptItem } from "../transcript/types.js";

function pendingInterruptFromItems(
  items: TranscriptItem[],
): PendingInterrupt | undefined {
  for (const item of items) {
    if (item.kind === "approval_card" && !item.approval) {
      return { id: item.toolUseId, kind: "approval" };
    }
    if (item.kind === "clarification_card" && !item.approval) {
      return { id: item.toolUseId, kind: "clarification" };
    }
  }
  return undefined;
}

function itemKey(item: TranscriptItem): string {
  if (
    item.kind === "user_turn" ||
    item.kind === "agent_text" ||
    item.kind === "thinking"
  )
    return item.id;
  return item.toolUseId;
}

function TranscriptColumn({
  persistedMessages,
  liveItems,
  onResolve,
  onAnswer,
}: {
  persistedMessages: SessionMessage[];
  liveItems: TranscriptItem[];
  onResolve: (toolUseId: string, action: "approve" | "reject") => void;
  onAnswer: (toolUseId: string, answer: string | string[]) => void;
}): React.JSX.Element {
  const persistedItems = useMemo(
    () => convertPersistedMessages(persistedMessages),
    [persistedMessages],
  );
  const allItems = [...persistedItems, ...liveItems];

  return (
    <div
      data-testid="transcript-column"
      style={{
        maxWidth: 860,
        margin: "0 auto",
        padding: "0 var(--mantine-spacing-lg)",
      }}
    >
      {allItems.map((item) => (
        <div
          key={itemKey(item)}
          style={{ marginBottom: "var(--mantine-spacing-sm)" }}
        >
          <TranscriptItemRenderer
            item={item}
            onResolve={onResolve}
            onAnswer={onAnswer}
          />
        </div>
      ))}
    </div>
  );
}

// SessionView is the unified home + transcript component rendered persistently
// in the Shell (outside the route outlet), so it stays mounted across route
// changes and captures WS deltas that arrive before navigation settles.
export function SessionView({
  sessionId: sessionIdFromRoute,
}: {
  sessionId: string | null;
}): React.JSX.Element {
  // activeSessionId can be set eagerly by onSessionCreated (before URL change)
  // so WS events for a brand-new session are captured immediately.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    sessionIdFromRoute,
  );
  // Ref lets the WS handler (stale closure) always read the latest value.
  const activeSessionIdRef = useRef<string | null>(sessionIdFromRoute);

  const [liveItems, setLiveItems] = useState<TranscriptItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const queryClient = useQueryClient();

  const prevRouteIdRef = useRef<string | null>(sessionIdFromRoute);
  useEffect(() => {
    const prev = prevRouteIdRef.current;
    const curr = sessionIdFromRoute;
    prevRouteIdRef.current = curr;

    if (curr === null) {
      activeSessionIdRef.current = null;
      setActiveSessionId(null);
      setLiveItems([]);
      setIsRunning(false);
      return;
    }

    if (prev !== null && prev !== curr) {
      setLiveItems([]);
      setIsRunning(false);
    }

    activeSessionIdRef.current = curr;
    setActiveSessionId(curr);
  }, [sessionIdFromRoute]);

  const { data: messages = [] } = useQuery<SessionMessage[]>({
    queryKey: ["session", activeSessionId],
    queryFn: () =>
      fetch(`/api/sessions/${activeSessionId}`).then((r) => {
        if (!r.ok) throw new Error(`sessions/${activeSessionId} ${r.status}`);
        return r.json() as Promise<SessionMessage[]>;
      }),
    enabled: !!activeSessionId,
  });

  const handleSessionCreated = useCallback(
    (newId: string, firstMessage: string) => {
      activeSessionIdRef.current = newId;
      setActiveSessionId(newId);

      queryClient.setQueryData<SessionMeta[]>(["sessions"], (prev = []) => [
        {
          sessionId: newId,
          title: firstMessage.slice(0, 60),
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);
    },
    [queryClient],
  );

  const handleEnvelope = useCallback(
    (env: WsEnvelope) => {
      const sid = activeSessionIdRef.current;
      if (!sid) return;

      if (env.type === "RUN_FINISHED") {
        const { sessionId, message } = env.payload as {
          sessionId: string;
          message: SessionMessage;
        };
        if (sessionId !== sid) return;
        setIsRunning(false);
        setLiveItems([]);
        queryClient.setQueryData<SessionMessage[]>(
          ["session", sid],
          (prev = []) => [...prev, message],
        );
        return;
      }

      if (env.type === "TEXT_MESSAGE_CONTENT") {
        const { sessionId } = env.payload as { sessionId: string };
        if (sessionId === sid) setIsRunning(true);
      }

      setLiveItems((prev) => applyLiveEvent(prev, env, sid));
    },
    [queryClient],
  );

  const handleResolve = useCallback(
    (toolUseId: string, action: "approve" | "reject") => {
      setLiveItems((prev) =>
        prev.map((item) =>
          item.kind === "approval_card" && item.toolUseId === toolUseId
            ? { ...item, approval: "pending" }
            : item,
        ),
      );
      void fetch(`/api/sessions/${activeSessionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: action, resolvedBy: "console" }),
      });
    },
    [activeSessionId],
  );

  const handleAnswer = useCallback(
    (toolUseId: string, answer: string | string[]) => {
      setLiveItems((prev) =>
        prev.map((item) =>
          item.kind === "clarification_card" && item.toolUseId === toolUseId
            ? { ...item, approval: "pending" }
            : item,
        ),
      );
      const text = Array.isArray(answer) ? answer.join(", ") : answer;
      void fetch(`/api/sessions/${activeSessionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, resolvedBy: "console" }),
      });
    },
    [activeSessionId],
  );

  useConsoleWs(handleEnvelope);

  const pendingInterrupt = pendingInterruptFromItems(liveItems);

  if (!activeSessionId) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          height: "100%",
        }}
      >
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text c="dimmed" size="sm">
            Start a conversation to begin an investigation.
          </Text>
        </div>
        <ChatInput
          sessionId={null}
          isRunning={false}
          onSessionCreated={handleSessionCreated}
        />
      </div>
    );
  }

  return (
    <div
      className="nw-page"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <div
        style={{
          flex: 1,
          padding: "var(--mantine-spacing-md) 0",
          overflowY: "auto",
        }}
      >
        <TranscriptColumn
          persistedMessages={messages}
          liveItems={liveItems}
          onResolve={handleResolve}
          onAnswer={handleAnswer}
        />
      </div>

      <ChatInput
        sessionId={activeSessionId}
        isRunning={isRunning}
        pendingInterrupt={pendingInterrupt}
      />
    </div>
  );
}
