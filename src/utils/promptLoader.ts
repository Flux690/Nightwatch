import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let toolPolicyCache: string | null = null;

function getToolPolicy(): string {
  if (toolPolicyCache === null) {
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = dirname(thisFile);
    const policyPath = join(thisDir, "..", "tools", "tool-policy.md");
    toolPolicyCache = readFileSync(policyPath, "utf-8").trim();
  }
  return toolPolicyCache;
}

/**
 * Load a prompt file relative to the calling module.
 * Replaces `{tool_policy}` placeholder with shared tool policy if present.
 * @param importMetaUrl - Pass `import.meta.url` from the calling module
 * @param filename - Prompt filename (default: "prompt.md")
 */
export function loadPrompt(
  importMetaUrl: string,
  filename: string = "prompt.md",
): string {
  const __filename = fileURLToPath(importMetaUrl);
  const __dirname = dirname(__filename);
  let content = readFileSync(join(__dirname, filename), "utf-8").trim();
  if (content.includes("{tool_policy}")) {
    content = content.replace("{tool_policy}", getToolPolicy());
  }
  return content;
}
