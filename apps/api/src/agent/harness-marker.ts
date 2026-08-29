// A harness turn is sent in the user's role and marked in its own text. The
// marker means something only because it is stripped from every other source.
// Named for the role, not the product: the model is itself called NightWarden.
const TAG = "harness";

// Attributes and spacing included, but only this tag: what follows the name has
// to be a space or the close, or a `<harness-...>` sibling would match too.
const ANY_MARKER = new RegExp(`<\\s*/?\\s*${TAG}(?=[\\s>])[^>]*>`, "gi");

export function harnessTurn(text: string): string {
  return `<${TAG}>\n${text}\n</${TAG}>`;
}

/* Applied to the person, the tools and the alert - everything but the harness.
   Repeated to a fixed point because one pass reassembles: removing the inner tag
   of `<har<harness>ness>` leaves a whole one behind. */
export function stripHarnessMarker(text: string): string {
  let out = text;
  for (let previous = ""; out !== previous;) {
    previous = out;
    out = out.replace(ANY_MARKER, "");
  }
  return out;
}
