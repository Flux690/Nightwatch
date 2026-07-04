import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  SessionMeta,
  SessionMessage,
  ConsoleEvent,
  ConsoleHumanInputRequired,
  ApprovalRequest,
} from "@nightwatch/shared";

import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { toast } from "@/lib/toast";
import { useAuth } from "@/auth/AuthContext";
import { useConsoleWs } from "@/hooks/ConsoleWsProvider";
import { ChatInput } from "@/components/transcript/ChatInput";
import { applyLiveEvent } from "@/components/transcript/liveConverter";
import { convertPersistedMessages } from "@/components/transcript/persistedConverter";
import { TranscriptItemRenderer } from "@/components/transcript/TranscriptItemRenderer";
import type { TranscriptItem } from "@/components/transcript/types";
import { apiFetch } from "@/api/client";

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
    <MessageScrollerContent
      data-testid="transcript-column"
      role="log"
      aria-label="Session transcript"
      className="mx-auto w-full max-w-chat gap-0 px-6 pb-8 pt-4"
    >
      {allItems.map((item, index) => (
        <MessageScrollerItem
          key={itemKey(item)}
          scrollAnchor={index === allItems.length - 1}
          style={{
            marginTop:
              index === 0
                ? 0
                : item.kind === "user_turn"
                  ? 32
                  : item.kind === "thinking"
                    ? 4
                    : 8,
          }}
        >
          <TranscriptItemRenderer
            item={item}
            onResolve={onResolve}
            onAnswer={onAnswer}
          />
        </MessageScrollerItem>
      ))}
    </MessageScrollerContent>
  );
}

/** Index route (/) renders with no id; /sessions/$id passes the param. */
export function SessionView({
  sessionId: sessionIdFromRoute = null,
}: {
  sessionId?: string | null;
} = {}): React.JSX.Element {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    sessionIdFromRoute,
  );
  const activeSessionIdRef = useRef<string | null>(sessionIdFromRoute);

  const [liveItems, setLiveItems] = useState<TranscriptItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
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

  if (!activeSessionId) {
    return (
      <div className="flex h-full flex-1 flex-col items-center">
        <div className="flex flex-1 flex-col justify-center pb-[10vh]">
          <h1 className="m-0 mb-1.5 text-center text-3xl font-semibold tracking-[-0.4px] text-foreground">
            Hello, {displayName}
          </h1>
          <p className="m-0 mb-4 text-center text-sm text-muted-foreground">
            Start an investigation or ask about your fleet.
          </p>
        </div>
        <div className="w-full">
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
    <div className="flex h-full flex-col">
      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <TranscriptColumn
              persistedMessages={messages}
              liveItems={liveItems}
              onResolve={handleResolve}
              onAnswer={handleAnswer}
            />
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>

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
