/**
 * Knowledge persistence.
 * Stores facts in <basePath>/.nightwatch/knowledge.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const HEADER = "# Nightwatch Knowledge";

function knowledgePath(basePath: string): string {
  return path.join(basePath, ".nightwatch", "knowledge.md");
}

/**
 * Load knowledge content. Returns null if no facts exist.
 */
export function loadKnowledge(basePath: string): string | null {
  const filePath = knowledgePath(basePath);
  if (!existsSync(filePath)) {
    return null;
  }
  const content = readFileSync(filePath, "utf-8").trim();
  // Only header, no actual facts
  if (content === HEADER) {
    return null;
  }
  return content;
}

export function addFact(
  basePath: string,
  question: string,
  answer: string,
): void {
  const filePath = knowledgePath(basePath);
  const dir = path.dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let content: string;
  if (!existsSync(filePath)) {
    content = HEADER;
  } else {
    content = readFileSync(filePath, "utf-8").trimEnd();
  }
  content += `\n\n- ${question} → ${answer}`;
  writeFileSync(filePath, content, "utf-8");
}
