// An event rather than a prop: the card renders inside SessionView, which two
// parents mount, and only one holds the state that opens a report.

const EVENT = "nw:open-report";

export function openReport(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function onOpenReport(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
