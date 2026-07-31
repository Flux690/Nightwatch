import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ChevronRight } from "lucide-react";

import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Message } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import type { TranscriptItem, ThinkingItem } from "./types.js";
import { ToolCard } from "./toolPresentation.js";
import { ApprovalCardPanel } from "./ApprovalCardPanel.js";
import { ClarificationCardPanel } from "./ClarificationCardPanel.js";
import { ContinueCardPanel } from "./ContinueCardPanel.js";

function UserTurn({
  text,
  instant,
}: {
  text: string;
  instant?: boolean;
}): React.JSX.Element {
  return (
    <Message
      align="end"
      className={instant ? undefined : "animate-in fade-in duration-300"}
      data-testid="user-turn"
    >
      <Bubble variant="secondary">
        <BubbleContent className="text-base whitespace-pre-wrap">
          {text}
        </BubbleContent>
      </Bubble>
    </Message>
  );
}

function AgentMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="animate-in fade-in duration-300 prose prose-nightwarden max-w-none">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

// NightWarden speaking about the run, not the agent speaking. The heading says
// whose problem it is before the sentence explains which one.
function ErrorNotice({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      role="status"
      data-testid="error-notice"
      className="animate-in fade-in flex flex-col gap-1 rounded-md border border-fail bg-fail-tint px-3 py-2 duration-300"
    >
      <span className="text-sm font-medium text-fail">The run stopped</span>
      <p className="m-0 text-sm whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function ThinkingBlock({
  item,
}: {
  item: ThinkingItem;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(item.streaming);
  const prevStreaming = useRef(item.streaming);

  useEffect(() => {
    if (prevStreaming.current && !item.streaming) {
      const timer = setTimeout(() => setOpen(false), 800);
      prevStreaming.current = item.streaming;
      return () => clearTimeout(timer);
    }
    if (!prevStreaming.current && item.streaming) {
      setOpen(true);
    }
    prevStreaming.current = item.streaming;
  }, [item.streaming]);

  const trimmed = item.text.trim();

  // Empty reasoning is never a transcript item: the working animation stands in
  // for "the model is thinking" while nothing is shown. A thinking block renders
  // only once it has real text - so the chevron and body always exist together.
  if (!trimmed) return null;

  return (
    <div
      className="animate-in fade-in duration-300"
      data-testid="thinking-block"
      data-streaming={item.streaming}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-fit items-center gap-1.5 text-sm text-muted-foreground outline-none">
          <span className={item.streaming ? "animate-pulse" : undefined}>
            Thinking
          </span>
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform duration-200 group-aria-expanded:rotate-90"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="animate-in fade-in duration-500 whitespace-pre-wrap text-sm text-muted-foreground">
            {trimmed}
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function TranscriptItemRenderer({
  item,
  submitting = false,
  onResolve,
  onAnswer,
}: {
  item: TranscriptItem;
  submitting?: boolean;
  onResolve?: (
    toolUseId: string,
    action: "approve" | "reject",
    reason?: string,
  ) => void;
  onAnswer?: (toolUseId: string, answer: string | string[]) => void;
}): React.JSX.Element {
  switch (item.kind) {
    case "user_turn":
      return <UserTurn text={item.text} instant={item.instant} />;
    case "agent_text":
      return <AgentMarkdown text={item.text} />;
    case "error_text":
      // Reversing the earlier choice to render these exactly like agent text:
      // the text is already status-specific - 401 says the key was rejected,
      // 429 says rate-limited - and prose erased the distinction, so a provider
      // outage read as the agent reasoning badly.
      return <ErrorNotice text={item.text} />;
    case "thinking":
      return <ThinkingBlock item={item} />;
    case "tool_card":
      return <ToolCard item={item} />;
    case "approval_card":
      return (
        <ApprovalCardPanel
          item={item}
          submitting={submitting}
          onResolve={
            onResolve
              ? (action, reason) => onResolve(item.toolUseId, action, reason)
              : undefined
          }
        />
      );
    case "clarification_card":
      return (
        <ClarificationCardPanel
          item={item}
          submitting={submitting}
          onAnswer={
            onAnswer ? (answer) => onAnswer(item.toolUseId, answer) : undefined
          }
        />
      );
    case "continue_card":
      return (
        <ContinueCardPanel
          item={item}
          submitting={submitting}
          onResolve={
            onResolve
              ? (action) => onResolve(item.toolUseId, action)
              : undefined
          }
        />
      );
  }
}
