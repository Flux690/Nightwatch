// Scroll and mark, never open. An event rather than shared state, because the
// two are siblings with no common owner.

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
