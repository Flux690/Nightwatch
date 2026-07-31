import { useSessions } from "./useSessions";

// Derived from the session list, never fetched separately: a parallel query can
// outlive the sessions it counts, and waiting sessions lead the first page.
export function useAttentionCount(): {
  count: number;
  firstSessionId: string | null;
} {
  const { sessions } = useSessions();

  const awaiting = sessions.filter((s) => s.awaitingHumanInput);
  return {
    count: awaiting.length,
    firstSessionId: awaiting[0]?.sessionId ?? null,
  };
}
