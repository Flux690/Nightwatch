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
import type { TranscriptItem, ThinkingItem, ToolCardItem } from "./types.js";
import { ToolCardPanel } from "./ToolCardPanel.js";
import { ApprovalCardPanel } from "./ApprovalCardPanel.js";
import { ClarificationCardPanel } from "./ClarificationCardPanel.js";
import { ContinueCardPanel } from "./ContinueCardPanel.js";
import { DiffCard, parseFileChange } from "./DiffCard.js";
import { TerminalCard, parseExecResult } from "./TerminalCard.js";
import { PRCard, parsePullRequestResult } from "./PRCard.js";

/* Repo tools return structured payloads and get bespoke cards; anything that
   doesn't parse falls back to the generic IN/OUT panel. */
function renderToolCard(item: ToolCardItem): React.JSX.Element {
  if (item.result !== null) {
    if (
      item.toolName === "Edit" ||
      item.toolName === "Write"
    ) {
      const change = parseFileChange(item.result);
      if (change !== null) {
        return <DiffCard toolName={item.toolName} change={change} />;
      }
    }
    if (item.toolName === "Bash") {
      const exec = parseExecResult(item.result);
      if (exec !== null) {
        return <TerminalCard input={item.input} result={exec} />;
      }
    }
    if (item.toolName === "OpenPullRequest") {
      const pr = parsePullRequestResult(item.result);
      if (pr !== null) return <PRCard pr={pr} />;
    }
  }
  return (
    <ToolCardPanel
      toolName={item.toolName}
      input={item.input}
      result={item.result}
    />
  );
}

function UserTurn({ text }: { text: string }): React.JSX.Element {
  return (
    <Message
      align="end"
      className="animate-in fade-in duration-300"
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

  return (
    <div
      className="animate-in fade-in duration-300"
      data-testid="thinking-block"
      data-streaming={item.streaming}
    >
      {!trimmed && item.streaming ? (
        <span className="text-sm text-muted-foreground animate-pulse">
          Thinking
        </span>
      ) : (
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
      )}
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
      return <UserTurn text={item.text} />;
    case "agent_text":
      return <AgentMarkdown text={item.text} />;
    case "error_text":
      // User's explicit choice: failures read like any other agent message.
      return <AgentMarkdown text={item.text} />;
    case "thinking":
      return <ThinkingBlock item={item} />;
    case "tool_card":
      return renderToolCard(item);
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
