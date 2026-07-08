// Minimal unified-diff renderer for tool results: one hunk spanning the
// changed region with three lines of context. Correct for the localized
// changes string-anchored edits produce; a multi-region replace_all degrades
// to one wide hunk, which is still a valid unified diff.

const CONTEXT_LINES = 3;

export function unifiedDiff(
  path: string,
  before: string | null,
  after: string,
): string {
  const a = before === null ? [] : before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const preStart = Math.max(0, start - CONTEXT_LINES);
  const postEndA = Math.min(a.length, endA + CONTEXT_LINES);

  const lines: string[] = [];
  for (let i = preStart; i < start; i++) lines.push(` ${a[i] ?? ""}`);
  for (let i = start; i < endA; i++) lines.push(`-${a[i] ?? ""}`);
  for (let i = start; i < endB; i++) lines.push(`+${b[i] ?? ""}`);
  for (let i = endA; i < postEndA; i++) lines.push(` ${a[i] ?? ""}`);

  const oldCount = postEndA - preStart;
  const newCount = start - preStart + (endB - start) + (postEndA - endA);
  const oldStart = oldCount === 0 ? 0 : preStart + 1;
  const newStart = newCount === 0 ? 0 : preStart + 1;

  const header =
    before === null
      ? `--- /dev/null\n+++ b/${path}`
      : `--- a/${path}\n+++ b/${path}`;
  return `${header}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join("\n")}`;
}
