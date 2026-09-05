import { z } from "zod";

// One definition for all four write tools, so the sentence on the approval card
// cannot drift. AskUserQuestion carries none: its `question` is the reason.
export const reason = z.string().meta({
  description:
    "One sentence stating why you are making this specific call. For example: 'Read the current maxmemory setting, which no read tool exposes' or 'Apply the fix by restarting the container so Compose reattaches the network'.",
});
