/* Lets the report reach a tool call in the transcript rail: scroll and mark,
   never open. The reader has read the output inline and came for position, so
   the mark is what makes the scroll visible among identical collapsed rows. */

/* An event rather than shared state: the report and the transcript are siblings
   under the Shell with no common owner, and threading a "reveal this id" prop
   through both subtrees would put a transient interaction into the data model. */

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
