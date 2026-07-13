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
    <div className="animate-in fade-in duration-300 prose prose-nightwatch max-w-none">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

function ThinkingBlock({ item }: { item: ThinkingItem }): React.JSX.Element {
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

  // One structure for the pre-text pulse and the filled dropdown: the word
  // never moves, the chevron slot is reserved (invisible) until text exists.
  return (
    <div
      className="animate-in fade-in duration-300"
      data-testid="thinking-block"
      data-streaming={item.streaming}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          disabled={!trimmed}
          className="group flex w-fit items-center gap-1.5 text-sm text-muted-foreground outline-none"
        >
          <span className={item.streaming ? "animate-pulse" : undefined}>
            Thinking
          </span>
          <ChevronRight
            aria-hidden="true"
            className={`size-3.5 shrink-0 transition-transform duration-200 group-aria-expanded:rotate-90 ${
              trimmed ? "" : "invisible"
            }`}
          />
        </CollapsibleTrigger>
        {trimmed && (
          <CollapsibleContent>
            <p className="animate-in fade-in duration-500 whitespace-pre-wrap text-sm text-muted-foreground">
              {trimmed}
            </p>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}

export function TranscriptItemRenderer({
  item,
  onResolve,
  onAnswer,
}: {
  item: TranscriptItem;
  onResolve?: (toolUseId: string, action: "approve" | "reject") => void;
  onAnswer?: (toolUseId: string, answer: string | string[]) => void;
}): React.JSX.Element {
  switch (item.kind) {
    case "user_turn":
      return <UserTurn text={item.text} instant={item.instant} />;
    case "agent_text":
      return <AgentMarkdown text={item.text} />;
    case "error_text":
      // User's explicit choice: failures read like any other agent message.
      return <AgentMarkdown text={item.text} />;
    case "thinking":
      return <ThinkingBlock item={item} />;
    case "tool_card":
      return <ToolCard item={item} />;
    case "approval_card":
      return (
        <ApprovalCardPanel
          item={item}
          onResolve={
            onResolve
              ? (action) => onResolve(item.toolUseId, action)
              : undefined
          }
        />
      );
    case "clarification_card":
      return (
        <ClarificationCardPanel
          item={item}
          onAnswer={
            onAnswer ? (answer) => onAnswer(item.toolUseId, answer) : undefined
          }
        />
      );
    case "continue_card":
      return (
        <ContinueCardPanel
          item={item}
          onResolve={
            onResolve
              ? (action) => onResolve(item.toolUseId, action)
              : undefined
          }
        />
      );
  }
}
