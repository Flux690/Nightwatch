import { useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Text } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConsoleInterrupt,
  ConsoleInterruptResolved,
  ConsoleToolCallEnd,
  ConsoleToolCallStart,
  RunnerRecord,
  SessionMeta,
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
  // Set on gated tools: the call waits behind a human approve/reject before it
  // executes. incidentId addresses the approve endpoint; toolUseId correlates.
  awaitingApproval?: boolean;
  incidentId?: string;
  risk?: string;
  approval?: "pending" | "approved" | "rejected" | "answered";
  resolvedBy?: string;
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
          border: "1px solid var(--nw-border)",
          borderRadius: "var(--mantine-radius-sm)",
          background: "var(--nw-surface)",
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
        <div style={{ borderTop: "1px solid var(--nw-border)" }} />
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

function ApprovalCard({
  card,
  onResolve,
}: {
  card: LiveToolCard;
  onResolve: (action: "approve" | "reject") => void;
}): React.JSX.Element {
  const resolved = card.approval === "approved" || card.approval === "rejected";

  return (
    <div
      data-testid="approval-card"
      style={{
        marginBottom: "var(--mantine-spacing-sm)",
        border: "1px solid var(--nw-status-awaiting)",
        borderRadius: "var(--mantine-radius-sm)",
        background: "var(--nw-surface)",
        padding: "var(--mantine-spacing-xs)",
      }}
    >
      <Text size="xs" ff="monospace" fw={600}>
        {card.toolName}
      </Text>
      <Text size="xs" c="dimmed" mb="xs">
        Risk: {card.risk ?? "unknown"}
      </Text>
      {resolved ? (
        <Text size="xs" data-testid="approval-resolution">
          {card.approval === "approved" ? "Approved" : "Rejected"}
          {card.resolvedBy ? ` by ${card.resolvedBy}` : ""}
        </Text>
      ) : (
        <div style={{ display: "flex", gap: "var(--mantine-spacing-xs)" }}>
          <Button
            size="xs"
            color="streaming"
            disabled={card.approval === "pending"}
            onClick={() => onResolve("approve")}
          >
            Approve
          </Button>
          <Button
            size="xs"
            color="escalated"
            variant="outline"
            disabled={card.approval === "pending"}
            onClick={() => onResolve("reject")}
          >
            Reject
          </Button>
        </div>
      )}
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

  const [liveItems, setLiveItems] = useState<LiveItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const queryClient = useQueryClient();

  // Track previous route-derived id so we can detect session switches.
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

    // Switching between two concrete sessions: clear stale live items.
    if (prev !== null && prev !== curr) {
      setLiveItems([]);
      setIsRunning(false);
    }

    activeSessionIdRef.current = curr;
    setActiveSessionId(curr);
  }, [sessionIdFromRoute]);

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () =>
      fetch("/api/runners").then((r) => {
        if (!r.ok) throw new Error(`runners ${r.status}`);
        return r.json() as Promise<RunnerRecord[]>;
      }),
  });
  const token = runners?.[0]?.token;

  const { data: messages = [] } = useQuery<SessionMessage[]>({
    queryKey: ["session", activeSessionId],
    queryFn: () =>
      fetch(`/api/sessions/${activeSessionId}?token=${token}`).then((r) => {
        if (!r.ok) throw new Error(`sessions/${activeSessionId} ${r.status}`);
        return r.json() as Promise<SessionMessage[]>;
      }),
    enabled: !!token && !!activeSessionId,
  });

  const handleSessionCreated = useCallback(
    (newId: string, firstMessage: string) => {
      // Set ref immediately so the WS handler captures events for newId before
      // TanStack Router completes the navigation to /sessions/:id.
      activeSessionIdRef.current = newId;
      setActiveSessionId(newId);

      if (token) {
        queryClient.setQueryData<SessionMeta[]>(
          ["sessions", token],
          (prev = []) => [
            {
              sessionId: newId,
              token,
              trigger: "chat",
              title: firstMessage.slice(0, 60),
              createdAt: new Date().toISOString(),
            },
            ...prev,
          ],
        );
      }
    },
    [token, queryClient],
  );

  const handleEnvelope = useCallback(
    (env: WsEnvelope) => {
      const sid = activeSessionIdRef.current;
      if (!sid) return;

      if (env.type === "TEXT_MESSAGE_CONTENT") {
        const { sessionId, delta } = env.payload as {
          sessionId: string;
          delta: string;
          kind: string;
        };
        if (sessionId !== sid) return;
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
      } else if (env.type === "RUN_FINISHED") {
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
      } else if (env.type === "TOOL_CALL_START") {
        const payload = env.payload as ConsoleToolCallStart["payload"];
        if (payload.sessionId !== sid) return;
        setLiveItems((prev) => [
          ...prev,
          {
            kind: "tool_card",
            toolUseId: payload.toolUseId,
            toolName: payload.toolName,
            input: payload.input,
            result: null,
            awaitingApproval: false,
          },
        ]);
      } else if (env.type === "INTERRUPT") {
        const payload = env.payload as ConsoleInterrupt["payload"];
        if (payload.sessionId !== sid) return;
        const riskValue = payload.input["risk"];
        setLiveItems((prev) => [
          ...prev,
          {
            kind: "tool_card",
            toolUseId: payload.toolUseId,
            toolName: payload.toolName,
            input: payload.input,
            result: null,
            awaitingApproval: true,
            incidentId: payload.incidentId,
            risk: typeof riskValue === "string" ? riskValue : undefined,
          },
        ]);
      } else if (env.type === "TOOL_CALL_END") {
        const payload = env.payload as ConsoleToolCallEnd["payload"];
        if (payload.sessionId !== sid) return;
        setLiveItems((prev) =>
          prev.map((item) =>
            item.kind === "tool_card" && item.toolUseId === payload.toolUseId
              ? { ...item, result: payload.result ?? null }
              : item,
          ),
        );
      } else if (env.type === "INTERRUPT_RESOLVED") {
        const payload = env.payload as ConsoleInterruptResolved["payload"];
        if (payload.status === "context_added") return;
        // Extract after the guard: TypeScript doesn't narrow payload.status inside
        // the map closure, so we pull the narrowed value out explicitly.
        const approval = payload.status as "approved" | "rejected";
        const resolvedBy = payload.resolvedBy;
        setLiveItems((prev) =>
          prev.map((item) =>
            item.kind === "tool_card" && item.toolUseId === payload.toolUseId
              ? { ...item, approval, resolvedBy }
              : item,
          ),
        );
      }
    },
    [queryClient],
  );

  const handleResolve = useCallback(
    (card: LiveToolCard, action: "approve" | "reject") => {
      if (!card.incidentId) return;
      setLiveItems((prev) =>
        prev.map((item) =>
          item.kind === "tool_card" && item.toolUseId === card.toolUseId
            ? { ...item, approval: "pending" }
            : item,
        ),
      );
      void fetch(`/api/incidents/${card.incidentId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "console" }),
      });
    },
    [],
  );

  useConsoleWs(handleEnvelope);

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
          token={token ?? ""}
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
          if (!item.awaitingApproval) {
            return <ToolCard key={item.toolUseId} card={item} />;
          }
          const resolved =
            item.approval === "approved" || item.approval === "rejected";
          return (
            <div key={item.toolUseId}>
              <ApprovalCard
                card={item}
                onResolve={(action) => handleResolve(item, action)}
              />
              {resolved ? <ToolCard card={item} /> : null}
            </div>
          );
        })}
      </div>

      <ChatInput
        token={token ?? ""}
        sessionId={activeSessionId}
        isRunning={isRunning}
      />
    </div>
  );
}

export function SessionTranscript(): React.JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const queryClient = useQueryClient();
  const [liveItems, setLiveItems] = useState<LiveItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () =>
      fetch("/api/runners").then((r) => {
        if (!r.ok) throw new Error(`runners ${r.status}`);
        return r.json() as Promise<RunnerRecord[]>;
      }),
  });

  const token = runners?.[0]?.token;

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
      if (env.type === "TEXT_MESSAGE_CONTENT") {
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
      } else if (env.type === "RUN_FINISHED") {
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
      } else if (env.type === "TOOL_CALL_START") {
        const payload = env.payload as ConsoleToolCallStart["payload"];
        if (payload.sessionId !== id) return;
        setLiveItems((prev) => [
          ...prev,
          {
            kind: "tool_card",
            toolUseId: payload.toolUseId,
            toolName: payload.toolName,
            input: payload.input,
            result: null,
            awaitingApproval: false,
          },
        ]);
      } else if (env.type === "INTERRUPT") {
        const payload = env.payload as ConsoleInterrupt["payload"];
        if (payload.sessionId !== id) return;
        const riskValue = payload.input["risk"];
        setLiveItems((prev) => [
          ...prev,
          {
            kind: "tool_card",
            toolUseId: payload.toolUseId,
            toolName: payload.toolName,
            input: payload.input,
            result: null,
            awaitingApproval: true,
            incidentId: payload.incidentId,
            risk: typeof riskValue === "string" ? riskValue : undefined,
          },
        ]);
      } else if (env.type === "TOOL_CALL_END") {
        const payload = env.payload as ConsoleToolCallEnd["payload"];
        if (payload.sessionId !== id) return;
        setLiveItems((prev) =>
          prev.map((item) =>
            item.kind === "tool_card" && item.toolUseId === payload.toolUseId
              ? { ...item, result: payload.result ?? null }
              : item,
          ),
        );
      } else if (env.type === "INTERRUPT_RESOLVED") {
        // No sessionId on this channel - correlate by toolUseId, which is global.
        const payload = env.payload as ConsoleInterruptResolved["payload"];
        if (payload.status === "context_added") return;
        const resolution = payload.status;
        const resolvedBy = payload.resolvedBy;
        setLiveItems((prev) =>
          prev.map((item) =>
            item.kind === "tool_card" && item.toolUseId === payload.toolUseId
              ? { ...item, approval: resolution, resolvedBy }
              : item,
          ),
        );
      }
    },
    [id, queryClient],
  );

  const handleResolve = useCallback(
    (card: LiveToolCard, action: "approve" | "reject") => {
      if (!card.incidentId) return;
      // Optimistically mark pending so both buttons disable; the durable state
      // arrives via the approval_update event.
      setLiveItems((prev) =>
        prev.map((item) =>
          item.kind === "tool_card" && item.toolUseId === card.toolUseId
            ? { ...item, approval: "pending" }
            : item,
        ),
      );
      void fetch(`/api/incidents/${card.incidentId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "console" }),
      });
    },
    [],
  );

  useConsoleWs(handleEnvelope);

  return (
    <div
      className="nw-page"
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
          if (!item.awaitingApproval) {
            return <ToolCard key={item.toolUseId} card={item} />;
          }
          // Gated: the approval card stands alone until resolved; only then does
          // the execution record (tool card) appear below it.
          const resolved =
            item.approval === "approved" || item.approval === "rejected";
          return (
            <div key={item.toolUseId}>
              <ApprovalCard
                card={item}
                onResolve={(action) => handleResolve(item, action)}
              />
              {resolved ? <ToolCard card={item} /> : null}
            </div>
          );
        })}
      </div>

      <ChatInput token={token ?? ""} sessionId={id} isRunning={isRunning} />
    </div>
  );
}
