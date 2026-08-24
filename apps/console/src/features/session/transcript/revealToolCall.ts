/* Scroll and mark, never open: the reader came for position. An event rather
   than shared state, because the report and the transcript are siblings with no
   common owner and a "reveal this id" prop would outlive the interaction. */

const EVENT = "nw:reveal-tool-call";

export const REVEAL_MS = 1600;

export function revealToolCall(toolUseId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: toolUseId }));
  document
    .getElementById(`tool-${toolUseId}`)
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
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
