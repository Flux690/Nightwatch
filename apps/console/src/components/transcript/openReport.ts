/* An event rather than a prop, for the reason revealToolCall is one: the card
   renders inside SessionView, mounted both by the investigation page and by the
   rail inside it, and only one of those holds the state that opens a report. */

const EVENT = "nw:open-report";

export function openReport(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function onOpenReport(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
