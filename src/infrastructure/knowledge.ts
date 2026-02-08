/**
 * Knowledge persistence.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

const KNOWLEDGE_PATH = path.resolve(process.cwd(), "knowledge.md");

const HEADER = "# Nightwatch Knowledge";

/**
 * Load knowledge content. Returns null if no facts exist.
 */
export function loadKnowledge(): string | null {
  if (!existsSync(KNOWLEDGE_PATH)) {
    return null;
  }
  const content = readFileSync(KNOWLEDGE_PATH, "utf-8").trim();
  // Only header, no actual facts
  if (content === HEADER) {
    return null;
  }
  return content;
}

export function addFact(question: string, answer: string): void {
  let content: string;
  if (!existsSync(KNOWLEDGE_PATH)) {
    content = HEADER;
  } else {
    content = readFileSync(KNOWLEDGE_PATH, "utf-8").trimEnd();
  }
  content += `\n\n- ${question} → ${answer}`;
  writeFileSync(KNOWLEDGE_PATH, content, "utf-8");
}
