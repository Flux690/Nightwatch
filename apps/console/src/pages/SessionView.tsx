import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleEvent, TranscriptItem } from "@nightwarden/shared";
import { transcriptItemKey } from "@nightwarden/shared";

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
import { useConsoleEvents } from "@/hooks/ConsoleEventsProvider";
import { useSession } from "@/hooks/useSession";
import { prependSession } from "@/hooks/useSessions";
import { ChatInput } from "@/components/transcript/ChatInput";
import {
  applyLiveEvent,
  hasActiveStream,
} from "@/components/transcript/liveConverter";
import { TranscriptItemRenderer } from "@/components/transcript/TranscriptItemRenderer";
import { WorkingIndicator } from "@/components/transcript/WorkingIndicator";
import { apiFetch } from "@/api/client";

// A stable empty default, so an unloaded transcript does not remount the column.
const EMPTY_ITEMS: TranscriptItem[] = [];

// The one card the session is waiting on, wherever it came from: the projected
// transcript after a reload, or the live stream during a run.
function awaitingCard(
  ...lists: TranscriptItem[][]
): TranscriptItem | undefined {
  for (const items of lists) {
    for (const item of items) {
      const isCard =
        item.kind === "approval_card" ||
        item.kind === "clarification_card" ||
        item.kind === "continue_card";
      if (isCard && item.state.phase === "awaiting_human") return item;
    }
  }
  return undefined;
}

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
  persistedItems: fetched,
  liveItems,
  pendingEcho,
  lastEchoText,
  showWorking,
  dockedKey,
  submittingToolUseId,
  onResolve,
  onAnswer,
}: {
  persistedItems: TranscriptItem[];
  liveItems: TranscriptItem[];
  // Rendered above the chat input instead of inline, so it never scrolls away.
  dockedKey: string | null;
  pendingEcho: string | null;
  lastEchoText: string | null;
  showWorking: boolean;
  submittingToolUseId: string | null;
  onResolve: (
    toolUseId: string,
    action: "approve" | "reject",
    reason?: string,
  ) => void;
  onAnswer: (toolUseId: string, answer: string | string[]) => void;
}): React.JSX.Element {
  const persistedItems = useMemo(() => {
    if (lastEchoText === null) return fetched;
    // The persisted copy of a just-echoed bubble mounts without the fade so
    // the echo-to-persisted swap has no visible frame.
    return fetched.map((item) =>
      item.kind === "user_turn" && item.text === lastEchoText
        ? { ...item, instant: true }
        : item,
    );
  }, [fetched, lastEchoText]);

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

  // Live events update the fetched list in place rather than competing with it:
  // a card can be replaced by a newer version of itself, never discarded.
  const merged = [...persistedItems, ...(echoItem ? [echoItem] : [])];
  for (const item of liveItems) {
    const key = transcriptItemKey(item);
    const at = merged.findIndex((seen) => transcriptItemKey(seen) === key);
    if (at === -1) merged.push(item);
    else merged[at] = item;
  }
  const allItems = merged.filter(
    (item) => transcriptItemKey(item) !== dockedKey,
  );

  return (
    <MessageScrollerContent
      data-testid="transcript-column"
      role="log"
      aria-label="Session transcript"
      className="mx-auto w-full max-w-chat gap-0 px-6 pb-8 pt-4"
    >
      {allItems.map((item, index) => (
        <MessageScrollerItem
          key={transcriptItemKey(item)}
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
            submitting={
              "toolUseId" in item && item.toolUseId === submittingToolUseId
            }
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

/** /agent renders with no id; the two $id routes pass the param. */
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

  const session = useSession(activeSessionId);

  /* Arriving at a session that is already working. The live state below is this
     component's, so leaving and returning starts it empty; the snapshot is the
     only thing that can say a run is in flight. Read once per session, because
     after that the stream is the truth and a refetch mid-suspend would undo it. */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (activeSessionId === null || session === null) return;
    if (session.sessionId !== activeSessionId) return;
    if (seededFor.current === activeSessionId) return;
    seededFor.current = activeSessionId;
    if (session.running) setIsRunning(true);
  }, [session, activeSessionId]);

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
      seededFor.current = null;
      return;
    }

    if (prev !== null && prev !== curr) {
      setLiveItems([]);
      setIsRunning(false);
      setPendingEcho(null);
      lastEchoRef.current = null;
      setActivityNotice(null);
      seededFor.current = null;
    }

    activeSessionIdRef.current = curr;
    setActiveSessionId(curr);
  }, [sessionIdFromRoute]);

  const persistedItems = session?.transcript ?? EMPTY_ITEMS;

  const handleSessionCreated = useCallback(
    (newId: string, firstMessage: string) => {
      activeSessionIdRef.current = newId;
      setActiveSessionId(newId);

      // A typed message opens a chat and it stays one, so the row goes to the
      // chat list and never moves.
      prependSession(queryClient, {
        sessionId: newId,
        title: firstMessage.slice(0, 60),
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        investigation: false,
        severity: null,
        severityLabel: null,
        status: null,
        finding: null,
        awaitingHumanInput: false,
      });
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
        // Streamed text and reasoning carry ephemeral ids the refetch cannot
        // match, so an assistant or error row drops them; tool cards key on
        // toolUseId and are updated in place instead.
        if (message.kind === "assistant" || message.kind === "error") {
          setLiveItems([]);
        }
        void queryClient.invalidateQueries({ queryKey: ["session", sid] });
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
        if (env.payload.sessionId !== sid) return;
        setIsRunning(false);
        setActivityNotice(null);
        setPendingEcho(null);
        setLiveItems([]);
        void queryClient.invalidateQueries({ queryKey: ["session", sid] });
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
    (toolUseId: string, action: "approve" | "reject", reason?: string) => {
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
        // The comment rides the same request the decision does; the API feeds it
        // to the agent so a rejection says why instead of only saying no.
        body: {
          decision: action,
          resolvedBy: "console",
          ...(reason !== undefined && { text: reason }),
        },
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
    // No transcript item is seeded: the run being active with nothing streaming
    // is what surfaces the working animation. A just-answered card still live
    // (not yet flushed by the resumed run) is left untouched so it survives.
    setIsRunning(true);
  }, []);

  // The POST never reached the API, so the server has no record of the
  // message: undo the echo (ChatInput restores the text).
  const handleSendFailed = useCallback(() => {
    setPendingEcho(null);
    setLiveItems([]);
    setIsRunning(false);
  }, []);

  const awaitingItem = awaitingCard(persistedItems, liveItems);
  const submittingToolUseId = respond.isPending
    ? (respond.variables?.toolUseId ?? null)
    : null;
  // The run is working but silent: nothing is streaming into the transcript, so
  // show the animation in the reply's place. Any live streaming tail hides it.
  const showWorking = isRunning && !hasActiveStream(liveItems);

  if (!activeSessionId) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center">
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

  return (
    <MessageScrollerProvider defaultScrollPosition="end">
      <div className="flex h-full flex-col">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <TranscriptColumn
              persistedItems={persistedItems}
              liveItems={liveItems}
              pendingEcho={pendingEcho}
              lastEchoText={lastEchoRef.current}
              showWorking={showWorking}
              dockedKey={awaitingItem ? transcriptItemKey(awaitingItem) : null}
              submittingToolUseId={submittingToolUseId}
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

        {awaitingItem && (
          <div className="mx-auto mb-2 w-full max-w-chat px-6">
            <TranscriptItemRenderer
              item={awaitingItem}
              submitting={
                "toolUseId" in awaitingItem &&
                awaitingItem.toolUseId === submittingToolUseId
              }
              onResolve={handleResolve}
              onAnswer={handleAnswer}
            />
          </div>
        )}

        <ScrollToEndChatInput
          sessionId={activeSessionId}
          isRunning={isRunning}
          onSend={handleSend}
          onSendFailed={handleSendFailed}
        />
      </div>
    </MessageScrollerProvider>
  );
}
