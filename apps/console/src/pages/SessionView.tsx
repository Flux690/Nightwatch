import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RunMode,
  SessionListRow,
  SessionMessage,
  SessionTranscript,
  ConsoleEvent,
  ApprovalRequest,
} from "@nightwarden/shared";

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
import { optimisticReport, useSessionReport } from "@/hooks/useSessionReport";
import { ChatInput } from "@/components/transcript/ChatInput";
import {
  applyLiveEvent,
  hasActiveStream,
} from "@/components/transcript/liveConverter";
import { convertPersistedMessages } from "@/components/transcript/persistedConverter";
import { TranscriptItemRenderer } from "@/components/transcript/TranscriptItemRenderer";
import { WorkingIndicator } from "@/components/transcript/WorkingIndicator";
import type { TranscriptItem } from "@/components/transcript/types";
import { apiFetch } from "@/api/client";

interface PendingInterrupt {
  id: string;
  kind: "approval" | "clarification" | "continue";
}

// A live row lands in the same cache entry the transcript fetch fills, so it has to
// preserve the pending half rather than replace the object with a bare array.
function appendPersistedMessage(
  queryClient: QueryClient,
  sessionId: string,
  message: SessionMessage,
): void {
  queryClient.setQueryData<SessionTranscript>(
    ["session", sessionId],
    (prev) => ({
      messages: [...(prev?.messages ?? []), message],
      pending: prev?.pending ?? null,
    }),
  );
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

function ScrollToEndChatInput(
  props: React.ComponentProps<typeof ChatInput>,
): React.JSX.Element {
  const { scrollToEnd } = useMessageScroller();
  const originalOnSend = props.onSend;

  const handleSend = useCallback(
    (text: string, mode: RunMode) => {
      originalOnSend?.(text, mode);
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
  persistedPending,
  liveItems,
  pendingEcho,
  lastEchoText,
  showWorking,
  onResolve,
  onAnswer,
}: {
  persistedMessages: SessionMessage[];
  persistedPending: ApprovalRequest | null;
  liveItems: TranscriptItem[];
  pendingEcho: string | null;
  lastEchoText: string | null;
  showWorking: boolean;
  onResolve: (toolUseId: string, action: "approve" | "reject") => void;
  onAnswer: (toolUseId: string, answer: string | string[]) => void;
}): React.JSX.Element {
  const persistedItems = useMemo(() => {
    const items = convertPersistedMessages(persistedMessages, persistedPending);
    if (lastEchoText === null) return items;
    // The persisted copy of a just-echoed bubble mounts without the fade so
    // the echo-to-persisted swap has no visible frame.
    return items.map((item) =>
      item.kind === "user_turn" && item.text === lastEchoText
        ? { ...item, instant: true }
        : item,
    );
  }, [persistedMessages, persistedPending, lastEchoText]);

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

  // The persisted transcript is authoritative: it arrives with its pending row
  // already joined, so a live card for the same tool_use is the same card twice.
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
      {showWorking && (
        <MessageScrollerItem
          className={allItems.length === 0 ? "mt-0" : "mt-2"}
        >
          <WorkingIndicator />
        </MessageScrollerItem>
      )}
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
  const { phase } = useAuth();

  // Locks the composer's mode picker away once this is an investigation.
  const investigation = useSessionReport(activeSessionId) !== null;
  // The session whose report cache this view seeded optimistically, so a
  // failed send can roll exactly that seed back.
  const seededReportRef = useRef<string | null>(null);

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

  const { data: transcript } = useQuery<SessionTranscript>({
    queryKey: ["session", activeSessionId],
    queryFn: () =>
      apiFetch<SessionTranscript>(`/api/sessions/${activeSessionId}`),
    enabled: !!activeSessionId,
  });
  const messages = transcript?.messages ?? [];
  const pendingForSession = transcript?.pending ?? null;

  const handleSessionCreated = useCallback(
    (newId: string, firstMessage: string, mode: RunMode) => {
      activeSessionIdRef.current = newId;
      setActiveSessionId(newId);

      const investigate = mode === "investigate";
      // An investigate start morphs the layout immediately: seed the report
      // cache now; the agent's first UpdateReport replaces it.
      if (investigate) {
        queryClient.setQueryData(["report", newId], optimisticReport());
      }
      queryClient.setQueryData<SessionListRow[]>(["sessions"], (prev = []) => [
        {
          sessionId: newId,
          title: firstMessage.slice(0, 60),
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          investigation: investigate,
          severity: null,
          target: null,
          status: investigate ? "investigating" : null,
          rootCauseLine: null,
          awaitingHumanInput: false,
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

      if (env.type === "MESSAGE") {
        const { sessionId, message } = env.payload;
        if (sessionId !== sid) return;
        // A persisted row, not a lifecycle signal - never touch isRunning here.
        // The optimistic echo clears once its own turn lands.
        setPendingEcho(null);
        // Assistant/error rows replace live streamed items whose ephemeral ids
        // can't dedup against the persisted copy, so drop them. Tool_result
        // (user) rows leave live tool cards for the persisted-key filter.
        if (message.role === "assistant" || message.role === "error") {
          setLiveItems([]);
        }
        appendPersistedMessage(queryClient, sid, message);
        return;
      }

      if (env.type === "RUN_FINISHED") {
        // The one terminal event for a self-completed run: settle run state.
        // The transcript is already whole - every row arrived as a MESSAGE.
        const { sessionId } = env.payload;
        if (sessionId !== sid) return;
        setIsRunning(false);
        setActivityNotice(null);
        setPendingEcho(null);
        setLiveItems([]);
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
        // The failure is a persisted transcript row: append it like a MESSAGE so
        // it renders in the conversation and survives reloads.
        appendPersistedMessage(queryClient, sid, message);
        return;
      }

      // A gated tool suspends the run for a human: it is terminal for the run
      // process, so settle run state, then fall through to render the card.
      if (env.type === "HUMAN_INPUT_REQUIRED") {
        if (env.payload.sessionId === sid) {
          setIsRunning(false);
          setActivityNotice(null);
        }
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

  const handleSend = useCallback(
    (text: string, mode: RunMode) => {
      setPendingEcho(text);
      lastEchoRef.current = text;
      // Escalation morphs optimistically: seed the report cache the moment the
      // send commits, without waiting for the agent's first UpdateReport.
      const sid = activeSessionIdRef.current;
      if (mode === "investigate" && sid !== null) {
        const existing = queryClient.getQueryData(["report", sid]);
        if (existing == null) {
          queryClient.setQueryData(["report", sid], optimisticReport());
          seededReportRef.current = sid;
        }
      }
      // No transcript item is seeded: the run being active with nothing streaming
      // is what surfaces the working animation. A just-answered card still live
      // (not yet flushed by the resumed run) is left untouched so it survives.
      setIsRunning(true);
    },
    [queryClient],
  );

  // The POST never reached the API, so the server has no record of the
  // message: undo the echo (ChatInput restores the text) and the morph seed.
  const handleSendFailed = useCallback(() => {
    setPendingEcho(null);
    setLiveItems([]);
    setIsRunning(false);
    if (seededReportRef.current !== null) {
      queryClient.setQueryData(["report", seededReportRef.current], null);
      seededReportRef.current = null;
    }
  }, [queryClient]);

  const pendingInterrupt = pendingInterruptFromItems(liveItems);
  // The run is working but silent: nothing is streaming into the transcript, so
  // show the animation in the reply's place. Any live streaming tail hides it.
  const showWorking = isRunning && !hasActiveStream(liveItems);

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
              persistedPending={pendingForSession}
              liveItems={liveItems}
              pendingEcho={pendingEcho}
              lastEchoText={lastEchoRef.current}
              showWorking={showWorking}
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
            investigation={investigation}
            onSend={handleSend}
            onSendFailed={handleSendFailed}
          />
        )}
      </div>
    </MessageScrollerProvider>
  );
}
