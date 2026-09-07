// The harness speaks in the user's role, so it marks its own text, and the
// marker means something only because it is stripped from every other source.
const TAG = "system-reminder";

// Attributes and spacing included, but only this tag: what follows the name has
// to be a space or the close, or a `<system-reminder-...>` sibling would match.
const ANY_MARKER = new RegExp(`<\\s*/?\\s*${TAG}(?=[\\s>])[^>]*>`, "gi");

export function asSystemReminder(text: string): string {
  return `<${TAG}>\n${text}\n</${TAG}>`;
}

/* Repeated to a fixed point because one pass reassembles: removing the inner
   tag of `<sys<system-reminder>tem-reminder>` leaves a whole one behind. */
export function stripSystemReminder(text: string): string {
  let out = text;
  for (let previous = ""; out !== previous;) {
    previous = out;
    out = out.replace(ANY_MARKER, "");
  }
  return out;
}
