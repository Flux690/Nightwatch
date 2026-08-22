import { transcriptItemKey } from "@nightwarden/shared";
import type { TranscriptItem } from "./types.js";

/* One list from the two the session holds, so whoever draws it does not also
   have to assemble it. Lifted out of the column because the parent needs the
   assembled list too: it decides which items are docked above the chat input
   rather than drawn inline, and it cannot pick from a list it never sees.
   Passing a key down for the column to skip worked for one docked card and
   would not survive a second. */

export interface MergeInput {
  persisted: TranscriptItem[];
  live: TranscriptItem[];
  // What the user just typed, drawn before the server has echoed it back.
  pendingEcho: string | null;
  // The text of the last echo, so its persisted copy can mount without a fade.
  lastEchoText: string | null;
}

/* The fetch can return the persisted user turn before any event is heard for a
   new session. If the last user turn already carries the echoed text, drawing
   the echo as well would double it. */
function echoAlreadyPersisted(
  persisted: TranscriptItem[],
  pendingEcho: string,
): boolean {
  for (let i = persisted.length - 1; i >= 0; i--) {
    const item = persisted[i];
    if (item?.kind === "user_turn") return item.text === pendingEcho;
  }
  return false;
}

export function mergeTranscript({
  persisted,
  live,
  pendingEcho,
  lastEchoText,
}: MergeInput): TranscriptItem[] {
  // The persisted copy of a just-echoed bubble mounts without the fade, so the
  // echo-to-persisted swap has no visible frame.
  const settled =
    lastEchoText === null
      ? persisted
      : persisted.map((item) =>
          item.kind === "user_turn" && item.text === lastEchoText
            ? { ...item, instant: true }
            : item,
        );

  const echo: TranscriptItem[] =
    pendingEcho !== null && !echoAlreadyPersisted(settled, pendingEcho)
      ? [{ kind: "user_turn", id: "pending-echo", text: pendingEcho }]
      : [];

  // A streamed turn lives only until the transcript holds it. Derived, so the
  // two can never both be drawn and there is no window where neither is.
  const savedTurns = new Set(
    settled.flatMap((item) => ("turn" in item ? [item.turn] : [])),
  );
  const streaming = live.filter(
    (item) => !("turn" in item) || !savedTurns.has(item.turn),
  );

  // Live events update the fetched list in place rather than competing with it:
  // a card can be replaced by a newer version of itself, never discarded.
  const merged = [...settled, ...echo];
  for (const item of streaming) {
    const key = transcriptItemKey(item);
    const at = merged.findIndex((seen) => transcriptItemKey(seen) === key);
    if (at === -1) merged.push(item);
    else merged[at] = item;
  }
  return merged;
}
