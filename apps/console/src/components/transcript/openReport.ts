/* The report card asking for the report to be opened.

   An event rather than a prop, for the reason revealToolCall is one: the card
   renders inside SessionView, which is mounted both by the investigation page
   and by the chat rail inside it, and only one of those has the page state that
   opens a report. Threading a callback through both mount paths would put a
   transient interaction into the data model. */

const EVENT = "nw:open-report";

export function openReport(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function onOpenReport(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
