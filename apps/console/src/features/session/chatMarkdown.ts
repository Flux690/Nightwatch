import type { TranscriptItem } from "@nightwarden/shared";

/* The conversation as something to paste into a document or an issue: what was
   said, and nothing else. Thinking is collapsed on screen for the same reason it
   is absent here, and a tool call is work rather than a turn. */
export function chatToMarkdown(
  title: string,
  transcript: TranscriptItem[],
): string {
  const sections = [`# ${title}`];
  for (const item of transcript) {
    if (item.kind === "user_turn") {
      sections.push(`## User\n\n${item.text.trim()}`);
    } else if (item.kind === "agent_text") {
      sections.push(`## Assistant\n\n${item.text.trim()}`);
    }
  }
  return `${sections.join("\n\n")}\n`;
}
