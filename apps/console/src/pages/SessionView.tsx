import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import type {
  SessionMeta,
  SessionMessage,
  ConsoleEvent,
  ConsoleHumanInputRequired,
  ApprovalRequest,
} from "@nightwatch/shared";
import { Button } from "../ui/Button.js";
import { toast } from "../ui/Toast.js";
import { useAuth } from "../auth/AuthContext.js";
import { useConsoleWs } from "../hooks/ConsoleWsProvider.js";
import { ChatInput } from "./ChatInput.js";
import { applyLiveEvent } from "../transcript/liveConverter.js";
import { convertPersistedMessages } from "../transcript/persistedConverter.js";
import { TranscriptItemRenderer } from "../transcript/TranscriptItemRenderer.js";
import type { TranscriptItem } from "../transcript/types.js";
import { apiFetch } from "../api/client.js";

const SUGGESTIONS = [
  "Check pod health",
  "Review recent alerts",
  "Show fleet status",
  "Investigate last failure",
];

interface PendingInterrupt {
  id: string;
  kind: "approval" | "clarification" | "continue";
}

function pendingApprovalToEnvelope(
  p: ApprovalRequest,
): ConsoleHumanInputRequired {
  const isClarification = p.kind === "clarification";
  const isContinue = p.kind === "continue";
  const clarInput = isClarification
    ? (p.toolInput as {
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect?: boolean;
      })
    : null;
  return {
    messageId: `pending-${p.toolUseId}`,
    type: "HUMAN_INPUT_REQUIRED",
    payload: {
      sessionId: p.sessionId,
      toolUseId: p.toolUseId,
      toolName: p.toolName,
      input: p.toolInput,
      kind: isClarification
        ? "clarification"
        : isContinue
          ? "continue"
          : "approval",
      ...(clarInput !== null && {
        question: clarInput.question,
        options: clarInput.options,
        multiSelect: clarInput.multiSelect,
      }),
    },
  };
}

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
    if (item.kind === "continue_card" && !item.approval) {
      return { id: item.toolUseId, kind: "continue" };
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

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
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
      role="log"
      aria-label="Session transcript"
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "0 24px",
      }}
    >
      {allItems.map((item) => (
        <div key={itemKey(item)} style={{ marginBottom: 8 }}>
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

export function SessionView({
  sessionId: sessionIdFromRoute,
}: {
  sessionId: string | null;
}): React.JSX.Element {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    sessionIdFromRoute,
  );
  const activeSessionIdRef = useRef<string | null>(sessionIdFromRoute);

  const [liveItems, setLiveItems] = useState<TranscriptItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const shouldAutoScrollRef = useRef(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { phase } = useAuth();

  const displayName =
    phase.kind === "authenticated" ? displayNameFromEmail(phase.email) : "";

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
      apiFetch<SessionMessage[]>(`/api/sessions/${activeSessionId}`),
    enabled: !!activeSessionId,
  });

  const { data: pendingHumanInput = [] } = useQuery<ApprovalRequest[]>({
    queryKey: ["sessions-pending-human-input"],
    queryFn: () =>
      apiFetch<ApprovalRequest[]>("/api/sessions/pending-human-input"),
  });
  const pendingForSession = pendingHumanInput.find(
    (p) => p.sessionId === activeSessionId,
  );

  useEffect(() => {
    if (!activeSessionId || !pendingForSession) return;
    const env = pendingApprovalToEnvelope(pendingForSession);
    setLiveItems((prev) => {
      const alreadySeeded = prev.some(
        (item) =>
          (item.kind === "approval_card" ||
            item.kind === "clarification_card" ||
            item.kind === "continue_card") &&
          item.toolUseId === pendingForSession.toolUseId,
      );
      if (alreadySeeded) return prev;
      return applyLiveEvent(prev, env, activeSessionId);
    });
  }, [activeSessionId, pendingForSession]);

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
    (env: ConsoleEvent) => {
      const sid = activeSessionIdRef.current;
      if (!sid) return;

      if (env.type === "RUN_FINISHED") {
        const { sessionId, message } = env.payload;
        if (sessionId !== sid) return;
        setIsRunning(false);
        setLiveItems([]);
        queryClient.setQueryData<SessionMessage[]>(
          ["session", sid],
          (prev = []) => [...prev, message],
        );
        return;
      }

      if (env.type === "RUN_STOPPED") {
        const { sessionId } = env.payload;
        if (sessionId !== sid) return;
        setIsRunning(false);
        setLiveItems([]);
        return;
      }

      if (env.type === "RUN_FAILED") {
        const { sessionId, message } = env.payload;
        if (sessionId !== sid) return;
        setIsRunning(false);
        setLiveItems([]);
        toast.show({
          title: "Investigation failed",
          message,
          variant: "error",
        });
        return;
      }

      if (env.type === "TEXT_MESSAGE_CONTENT") {
        if (env.payload.sessionId === sid) setIsRunning(true);
      }

      setLiveItems((prev) => applyLiveEvent(prev, env, sid));
    },
    [queryClient],
  );

  const respond = useMutation({
    mutationFn: (vars: { toolUseId: string; body: Record<string, unknown> }) =>
      apiFetch<void>(`/api/sessions/${activeSessionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars.body),
      }),
    onError: (err, vars) => {
      setLiveItems((prev) =>
        prev.map((item) =>
          (item.kind === "approval_card" ||
            item.kind === "clarification_card" ||
            item.kind === "continue_card") &&
          item.toolUseId === vars.toolUseId
            ? { ...item, approval: undefined }
            : item,
        ),
      );
      toast.show({
        title: "Response not sent",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const handleResolve = useCallback(
    (toolUseId: string, action: "approve" | "reject") => {
      setLiveItems((prev) =>
        prev.map((item) =>
          (item.kind === "approval_card" || item.kind === "continue_card") &&
          item.toolUseId === toolUseId
            ? { ...item, approval: "pending" }
            : item,
        ),
      );
      respond.mutate({
        toolUseId,
        body: { decision: action, resolvedBy: "console" },
      });
    },
    [respond],
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
      respond.mutate({ toolUseId, body: { text, resolvedBy: "console" } });
    },
    [respond],
  );

  useConsoleWs(handleEnvelope);

  const pendingInterrupt = pendingInterruptFromItems(liveItems);

  function handleScroll(): void {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setShowScrollButton(!atBottom);
    shouldAutoScrollRef.current = atBottom;
  }

  function scrollToBottom(): void {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    shouldAutoScrollRef.current = true;
    setShowScrollButton(false);
  }

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    bottomRef.current?.scrollIntoView({
      behavior: "instant" as ScrollBehavior,
    });
  }, [liveItems, messages]);

  const createSession = useMutation({
    mutationFn: async (message: string) => {
      const data = await apiFetch<{ sessionId: string }>("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      handleSessionCreated(data.sessionId, message);
      return data.sessionId;
    },
    onSuccess: async (sessionId) => {
      await navigate({
        to: "/sessions/$id",
        params: { id: sessionId },
        replace: true,
      });
    },
    onError: (err) => {
      toast.show({
        title: "Could not start session",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  if (!activeSessionId) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          height: "100%",
          alignItems: "center",
        }}
      >
        <div
          style={{
            flex: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <h1 className="session-landing__greeting">Hello, {displayName}</h1>
            <div className="session-landing__suggestions">
              {SUGGESTIONS.map((s) => (
                <Button
                  key={s}
                  variant="secondary"
                  size="sm"
                  disabled={createSession.isPending}
                  onClick={() => createSession.mutate(s)}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ flex: 2, width: "100%", paddingTop: 8 }}>
          <ChatInput
            sessionId={null}
            isRunning={false}
            onSessionCreated={handleSessionCreated}
          />
        </div>
      </div>
    );
  }

  const composerHidden =
    pendingInterrupt?.kind === "approval" ||
    pendingInterrupt?.kind === "clarification";
  const composerDisabled = pendingInterrupt?.kind === "continue";

  return (
    <div
      className="page"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{
            height: "100%",
            overflowY: "auto",
            padding: "16px 0",
          }}
        >
          <TranscriptColumn
            persistedMessages={messages}
            liveItems={liveItems}
            onResolve={handleResolve}
            onAnswer={handleAnswer}
          />
          <div ref={bottomRef} />
        </div>
        {showScrollButton && (
          <button
            type="button"
            className="scroll-to-bottom"
            aria-label="Scroll to bottom"
            onClick={scrollToBottom}
          >
            <ChevronDown size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>

      {!composerHidden && (
        <ChatInput
          sessionId={activeSessionId}
          isRunning={isRunning}
          disabled={composerDisabled}
        />
      )}
    </div>
  );
}
