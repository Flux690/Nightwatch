import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConsoleEvent,
  SessionKind,
  TranscriptItem,
} from "@nightwarden/shared";
import { transcriptItemKey } from "@nightwarden/shared";
import { mergeTranscript } from "@/components/transcript/mergeTranscript";

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

/* What gets pinned above the message box, from the projection or the live
   stream. Only what stops the whole run qualifies: a question and the
   time-budget prompt. An approval gates one tool, so it stays inline. */
// What is waiting on the user, drawn above the input so it never scrolls away.
function dockedCard(items: TranscriptItem[]): TranscriptItem | undefined {
  for (const item of items) {
    if (item.kind === "continue_card") {
      if (item.state.phase === "awaiting_human") return item;
      continue;
    }
    if (
      item.kind === "tool_call" &&
      item.state.phase === "awaiting_human" &&
      item.state.gate === "clarification"
    )
      return item;
  }
  return undefined;
}

/* The report is not a message. It is the artifact the conversation produces,
   rewritten by every run, so no position among the messages is right: written
   where it happened it goes stale, and last it sits under a question asked
   after it. Docked, it is beside the input the whole time and the ordering
   question stops being asked. */
function dockedReport(items: TranscriptItem[]): TranscriptItem | undefined {
  return items.find((item) => item.kind === "report_card");
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
  items,
  showWorking,
  submittingToolUseId,
  onResolve,
  onAnswer,
  onRetryReport,
}: {
  // Already merged and already stripped of whatever is docked: the column draws
  // the list it is handed and decides nothing about what belongs in it.
  items: TranscriptItem[];
  showWorking: boolean;
  submittingToolUseId: string | null;
  onResolve: (
    toolUseId: string,
    action: "approve" | "reject",
    reason?: string,
  ) => void;
  onAnswer: (toolUseId: string, answer: string | string[]) => void;
  onRetryReport: () => void;
}): React.JSX.Element {
  return (
    <MessageScrollerContent
      data-testid="transcript-column"
      role="log"
      aria-label="Session transcript"
      className="mx-auto w-full max-w-chat gap-0 px-6 pb-8 pt-4"
    >
      {items.map((item, index) => (
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
            onRetryReport={onRetryReport}
          />
        </MessageScrollerItem>
      ))}
      {showWorking && (
        <MessageScrollerItem className={items.length === 0 ? "mt-0" : "mt-2"}>
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

  /* The live state below is this component's, so leaving and returning starts it
     empty and only the snapshot can say a run is in flight. Read once: after
     that the stream is the truth and a refetch mid-suspend would undo it. */
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
    (newId: string, firstMessage: string, kind: SessionKind) => {
      activeSessionIdRef.current = newId;
      setActiveSessionId(newId);

      // The mode the user picked is what the session is, from here on. The
      // row goes to that list and never moves between them.
      prependSession(queryClient, {
        sessionId: newId,
        title: firstMessage.slice(0, 60),
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        investigation: kind === "investigation",
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
        const { sessionId } = env.payload;
        if (sessionId !== sid) return;
        // A persisted row, not a lifecycle signal - never touch isRunning here.
        // The optimistic echo clears once its own turn lands.
        setPendingEcho(null);
        // Housekeeping, not correctness: the render already hides a streamed
        // turn the transcript holds. This only bounds the buffer.
        void queryClient
          .invalidateQueries({ queryKey: ["session", sid] })
          .then(() => setLiveItems([]));
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
    onError: (err) => {
      toast.show({
        title: "Response not sent",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const handleResolve = useCallback(
    (toolUseId: string, action: "approve" | "reject", reason?: string) => {
      // Nothing is stamped on the item: the decision in flight belongs to this
      // browser, and `submitting` below is what draws it.
      respond.mutate({
        toolUseId,
        // The comment rides the same request the decision does; the API feeds it
        // to the agent so a rejection says why instead of only saying no.
        body: {
          decision: action,
          ...(reason !== undefined && { text: reason }),
        },
      });
    },
    [respond],
  );

  // The same loop, tool and seed. The route exists so the sentence handed to the
  // model is versioned beside the others rather than composed here.
  const retryReport = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/sessions/${activeSessionId}/report/retry`, {
        method: "POST",
      }),
    onError: (err) => {
      toast.show({
        title: "Could not write the report",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const handleRetryReport = useCallback(() => {
    retryReport.mutate();
  }, [retryReport]);

  const handleAnswer = useCallback(
    (toolUseId: string, answer: string | string[]) => {
      const text = Array.isArray(answer) ? answer.join(", ") : answer;
      respond.mutate({ toolUseId, body: { text } });
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

  const allItems = mergeTranscript({
    persisted: persistedItems,
    live: liveItems,
    pendingEcho,
    lastEchoText: lastEchoRef.current,
  });
  const dockedItem = dockedCard(allItems);
  const reportItem = dockedReport(allItems);
  const docked = new Set(
    [dockedItem, reportItem].flatMap((item) =>
      item ? [transcriptItemKey(item)] : [],
    ),
  );
  const inlineItems = allItems.filter(
    (item) => !docked.has(transcriptItemKey(item)),
  );
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
              items={inlineItems}
              showWorking={showWorking}
              submittingToolUseId={submittingToolUseId}
              onResolve={handleResolve}
              onAnswer={handleAnswer}
              onRetryReport={handleRetryReport}
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

        {/* Above the gated card, so whatever is waiting on an answer stays
            nearest the input; both can be present at once. */}
        {reportItem && (
          <div className="mx-auto mb-2 w-full max-w-chat px-6">
            <TranscriptItemRenderer
              item={reportItem}
              onResolve={handleResolve}
              onAnswer={handleAnswer}
              onRetryReport={handleRetryReport}
            />
          </div>
        )}

        {dockedItem && (
          <div className="mx-auto mb-2 w-full max-w-chat px-6">
            <TranscriptItemRenderer
              item={dockedItem}
              submitting={
                "toolUseId" in dockedItem &&
                dockedItem.toolUseId === submittingToolUseId
              }
              onResolve={handleResolve}
              onAnswer={handleAnswer}
              onRetryReport={handleRetryReport}
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
