import type { TranscriptItem } from "@nightwarden/shared";

// What was said and nothing else: thinking is absent for the reason it is
// collapsed on screen, and a tool call is work rather than a turn.
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
