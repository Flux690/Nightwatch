// Shared chrome for the transcript cards that are still cards: the diff, the
// pull request, and the clarification prompt. Ordinary tool calls are rows now
// (see toolPresentation), so this is deliberately small.

// Cards never scroll: a preview shows at most this many lines.
const CARD_MAX_LINES = 3;

// A character cap alongside the line cap, because one enormous line is a single
// "line" that wraps into dozens of rows in a narrow rail.
const CARD_MAX_CHARS = 300;

export function firstLines(text: string, max = CARD_MAX_LINES): string {
  const lines = text.split("\n").slice(0, max).join("\n");
  return lines.length > CARD_MAX_CHARS
    ? `${lines.slice(0, CARD_MAX_CHARS)}...`
    : lines;
}

export const TOOL_CARD_CLASS = "gap-3 border border-border py-3 ring-0";
export const IO_LABEL_CLASS =
  "mb-1 font-mono text-sm font-medium tracking-[0.06em] text-muted-foreground";
