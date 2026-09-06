// Scroll and mark, never open. An event rather than shared state, because the
// two are siblings with no common owner.

const EVENT = "nw:reveal-tool-call";

export const REVEAL_MS = 1600;

export function revealToolCall(toolCallId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: toolCallId }));
  document
    .getElementById(`tool-${toolCallId}`)
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function onRevealToolCall(
  handler: (toolCallId: string) => void,
): () => void {
  const listener = (e: Event): void => {
    handler((e as CustomEvent<string>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
