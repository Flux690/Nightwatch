/* Lets the report reach a tool call in the transcript rail.
 *
 * Scrolling alone was not enough: a collapsed row looks identical before and
 * after, so "Show in transcript" appeared to do nothing and the reader had no
 * way to tell which of ten rows it meant. Revealing means three things at once
 * - open the row, bring it into view, and mark it briefly so the eye lands on
 * the right one.
 *
 * An event rather than shared state because the report and the transcript are
 * siblings under the Shell with no common owner, and threading a "reveal this
 * id" prop through both subtrees would put a transient interaction into the
 * data model. */

const EVENT = "nw:reveal-tool-call";

export const REVEAL_MS = 1600;

export function revealToolCall(toolUseId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: toolUseId }));
  // After the row has had a frame to expand, so the scroll targets its real
  // height rather than the collapsed one.
  requestAnimationFrame(() => {
    document
      .getElementById(`tool-${toolUseId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

export function onRevealToolCall(
  handler: (toolUseId: string) => void,
): () => void {
  const listener = (e: Event): void => {
    handler((e as CustomEvent<string>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
