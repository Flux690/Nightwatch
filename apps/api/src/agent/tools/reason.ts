// One definition for all four write tools, so the sentence on the approval card
// cannot drift. AskUserQuestion carries none: its `question` is the reason.
export const REASON_PROPERTY = {
  type: "string",
  description:
    "One sentence stating why you are making this specific call. A human reads it on the approval card and decides from it, so say what you expect this call to achieve. Gathering evidence is as legitimate a reason as applying a fix; state which one this is. For example: 'Read the current maxmemory setting, which no read tool exposes' or 'Apply the fix by restarting the container so Compose reattaches the network'.",
} as const;
