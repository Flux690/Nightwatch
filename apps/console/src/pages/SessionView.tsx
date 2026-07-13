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
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { toast } from "@/lib/toast";
import { useAuth } from "@/auth/AuthContext";
import { useConsoleEvents } from "@/hooks/ConsoleEventsProvider";
import { ChatInput } from "@/components/transcript/ChatInput";
import { applyLiveEvent } from "@/components/transcript/liveConverter";
import { convertPersistedMessages } from "@/components/transcript/persistedConverter";
import { TranscriptItemRenderer } from "@/components/transcript/TranscriptItemRenderer";
import type {
  ThinkingItem,
  TranscriptItem,
} from "@/components/transcript/types";
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
    item.kind === "error_text" ||
    item.kind === "thinking"
  )
    return item.id;
  return item.toolUseId;
}

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// Seeded into liveItems on send so the reply affordance is the very item the
// first thinking delta merges into: same key, same element, no remount.
const PENDING_THINKING: ThinkingItem = {
  kind: "thinking",
  id: "pending-thinking",
  text: "",
  streaming: true,
};

function ScrollToEndChatInput(
  props: React.ComponentProps<typeof ChatInput>,
): React.JSX.Element {
  const { scrollToEnd } = useMessageScroller();
  const originalOnSend = props.onSend;

  const handleSend = useCallback(
    (text: string) => {
      originalOnSend?.(text);
      requestAnimationFrame(() => {
        scrollToEnd({ behavior: "smooth" });
      });
    },
    [originalOnSend, scrollToEnd],
  );

  return <ChatInput {...props} onSend={handleSend} />;
}

function TranscriptColumn({
  persistedMessages,
  liveItems,
  pendingEcho,
  lastEchoText,
  onResolve,
  onAnswer,
}: {
  persistedMessages: SessionMessage[];
  liveItems: TranscriptItem[];
  pendingEcho: string | null;
  lastEchoText: string | null;
  onResolve: (toolUseId: string, action: "approve" | "reject") => void;
  onAnswer: (toolUseId: string, answer: string | string[]) => void;
}): React.JSX.Element {
  const persistedItems = useMemo(() => {
    const items = convertPersistedMessages(persistedMessages);
    if (lastEchoText === null) return items;
    // The persisted copy of a just-echoed bubble mounts without the fade so
    // the echo-to-persisted swap has no visible frame.
    return items.map((item) =>
      item.kind === "user_turn" && item.text === lastEchoText
        ? { ...item, instant: true }
        : item,
    );
  }, [persistedMessages, lastEchoText]);

  // The fetch can return the persisted user turn before any event is heard
  // for a newly-created session; if the last user turn already carries the
  // echoed text, the echo would double-render - suppress it.
  const echoPersisted = (): boolean => {
    for (let i = persistedItems.length - 1; i >= 0; i--) {
      const item = persistedItems[i];
      if (item?.kind === "user_turn") return item.text === pendingEcho;
    }
    return false;
  };
  const echoItem: TranscriptItem | null =
    pendingEcho !== null && !echoPersisted()
      ? { kind: "user_turn", id: "pending-echo", text: pendingEcho }
      : null;

  // A live card whose tool_use has since been persisted (e.g. an answered
  // question after the resumed run flushes) would render twice - drop it.
  const persistedKeys = new Set(persistedItems.map(itemKey));
  const allItems = [
    ...persistedItems,
    ...(echoItem ? [echoItem] : []),
    ...liveItems.filter((item) => !persistedKeys.has(itemKey(item))),
  ];

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
          className={
            index === 0
              ? "mt-0"
              : item.kind === "user_turn"
                ? "mt-8"
                : item.kind === "thinking"
                  ? "mt-1"
                  : "mt-2"
          }
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
  // Optimistic echo of the sent message, shown until its persisted row lands.
  const [pendingEcho, setPendingEcho] = useState<string | null>(null);
  // Outlives the echo so the persisted copy can skip its mount fade.
  const lastEchoRef = useRef<string | null>(null);
  // Live status line (provider retries, sandbox provisioning); any other run
  // event clears it.
  const [activityNotice, setActivityNotice] = useState<string | null>(null);
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
      setPendingEcho(null);
      lastEchoRef.current = null;
      setActivityNotice(null);
      return;
    }

    if (prev !== null && prev !== curr) {
      setLiveItems([]);
      setIsRunning(false);
      setPendingEcho(null);
      lastEchoRef.current = null;
      setActivityNotice(null);
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

      if (env.type === "SANDBOX_STATUS") {
        const { sessionId, stage } = env.payload;
        if (sessionId !== sid) return;
        setActivityNotice(
          stage === "cloning"
            ? "Preparing sandbox - cloning the repository\u2026"
            : stage === "starting"
              ? "Preparing sandbox - starting the container\u2026"
              : stage === "installing"
                ? "Preparing sandbox - installing dependencies\u2026"
                : null,
        );
        return;
      }

      if (env.type === "RUN_RETRYING") {
        const { sessionId, summary } = env.payload;
        if (sessionId !== sid) return;
        setIsRunning(true);
        setActivityNotice(summary);
        return;
      }

      if (env.type === "RUN_FINISHED") {
        const { sessionId, message } = env.payload;
        if (sessionId !== sid) return;
        // Batched with the cache append below, so the echo-to-persisted swap
        // is one commit: no duplicate frame, no gap.
        setPendingEcho(null);
        if (message.role === "user") {
          // Persisting the human's own turn isn't the reply: keep only the
          // seeded pulse (same item reference, so its element never remounts).
          setLiveItems((prev) =>
            prev.filter(
              (item) =>
                item.kind === "thinking" && item.id === PENDING_THINKING.id,
            ),
          );
        } else {
          setIsRunning(false);
          setActivityNotice(null);
          setLiveItems([]);
        }
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
        setActivityNotice(null);
        setPendingEcho(null);
        setLiveItems([]);
        return;
      }

      if (env.type === "RUN_FAILED") {
        const { sessionId, message } = env.payload;
        if (sessionId !== sid) return;
        setIsRunning(false);
        setActivityNotice(null);
        setPendingEcho(null);
        setLiveItems([]);
        // The failure is a persisted transcript row: append it like RUN_FINISHED
        // does so it renders in the conversation and survives reloads.
        queryClient.setQueryData<SessionMessage[]>(
          ["session", sid],
          (prev = []) => [...prev, message],
        );
        return;
      }

      if (env.type === "TEXT_MESSAGE_CONTENT") {
        if (env.payload.sessionId === sid) {
          setIsRunning(true);
          setActivityNotice(null);
        }
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
      const text = Array.isArray(answer) ? answer.join(", ") : answer;
      // Stash the answer on the live card so the resolved Q/A view can show it
      // before the persisted transcript catches up.
      setLiveItems((prev) =>
        prev.map((item) =>
          item.kind === "clarification_card" && item.toolUseId === toolUseId
            ? { ...item, approval: "pending", result: text }
            : item,
        ),
      );
      respond.mutate({ toolUseId, body: { text, resolvedBy: "console" } });
    },
    [respond],
  );

  useConsoleEvents(handleEnvelope);

  const handleSend = useCallback((text: string) => {
    setPendingEcho(text);
    lastEchoRef.current = text;
    // Append, don't replace: a just-answered card can still be live (not yet
    // flushed by the resumed run) and must survive the send.
    setLiveItems((prev) => [
      ...prev.filter(
        (item) =>
          !(item.kind === "thinking" && item.id === PENDING_THINKING.id),
      ),
      PENDING_THINKING,
    ]);
    setIsRunning(true);
  }, []);

  // The POST never reached the API, so the server has no record of the
  // message: undo the echo and the pulse. ChatInput restores the text.
  const handleSendFailed = useCallback(() => {
    setPendingEcho(null);
    setLiveItems([]);
    setIsRunning(false);
  }, []);

  const pendingInterrupt = pendingInterruptFromItems(liveItems);

  if (!activeSessionId) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center">
        <h1 className="m-0 mb-1.5 text-center text-3xl font-semibold tracking-[-0.4px] text-foreground">
          Hello, {displayName}
        </h1>
        <p className="m-0 mb-6 text-center text-base text-muted-foreground">
          Start an investigation or ask about your fleet.
        </p>
        <div className="w-full">
          <ChatInput
            sessionId={null}
            isRunning={false}
            onSessionCreated={handleSessionCreated}
            onSend={handleSend}
            onSendFailed={handleSendFailed}
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
    <MessageScrollerProvider defaultScrollPosition="end">
      <div className="flex h-full flex-col">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <TranscriptColumn
              persistedMessages={messages}
              liveItems={liveItems}
              pendingEcho={pendingEcho}
              lastEchoText={lastEchoRef.current}
              onResolve={handleResolve}
              onAnswer={handleAnswer}
            />
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>

        {activityNotice && (
          <div className="mx-auto w-full max-w-chat px-6 pb-2">
            <span className="animate-pulse text-sm text-muted-foreground">
              {activityNotice}
            </span>
          </div>
        )}

        {!composerHidden && (
          <ScrollToEndChatInput
            sessionId={activeSessionId}
            isRunning={isRunning}
            disabled={composerDisabled}
            onSend={handleSend}
            onSendFailed={handleSendFailed}
          />
        )}
      </div>
    </MessageScrollerProvider>
  );
}
