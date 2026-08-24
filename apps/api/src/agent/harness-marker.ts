// A harness turn is sent in the user's role and marked in its own text. The
// marker means something only because it is stripped from every other source.
const TAG = "nightwarden";

// Attributes and spacing included: the model reads the tag name, not the syntax.
const ANY_MARKER = new RegExp(`<\\s*/?\\s*${TAG}\\b[^>]*>`, "gi");

export function harnessTurn(text: string): string {
  return `<${TAG}>\n${text}\n</${TAG}>`;
}

/* Applied to the person, the tools and the alert - everything but the harness.
   Repeated to a fixed point because one pass reassembles: removing the inner tag
   of `<night<nightwarden>warden>` leaves a whole one behind. */
export function stripHarnessMarker(text: string): string {
  let out = text;
  for (let previous = ""; out !== previous;) {
    previous = out;
    out = out.replace(ANY_MARKER, "");
  }
  return out;
}
