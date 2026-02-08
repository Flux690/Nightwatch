import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Load a prompt file relative to the calling module.
 * @param importMetaUrl - Pass `import.meta.url` from the calling module
 * @param filename - Prompt filename (default: "prompt.md")
 */
export function loadPrompt(
  importMetaUrl: string,
  filename: string = "prompt.md",
): string {
  const __filename = fileURLToPath(importMetaUrl);
  const __dirname = dirname(__filename);
  return readFileSync(join(__dirname, filename), "utf-8").trim();
}
