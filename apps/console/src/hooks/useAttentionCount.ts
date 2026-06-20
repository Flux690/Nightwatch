import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest, ConsoleEvent } from "@nightwatch/shared";
import { useConsoleWs } from "./useConsoleWs.js";

export function useAttentionCount(): number {
  const { data: pending = [] } = useQuery<ApprovalRequest[]>({
    queryKey: ["sessions-pending-human-input"],
    queryFn: () =>
      fetch("/api/sessions/pending-human-input").then((r) => {
        if (!r.ok) throw new Error(`pending-human-input ${r.status}`);
        return r.json() as Promise<ApprovalRequest[]>;
      }),
  });

  const [delta, setDelta] = useState(0);

  const handleEnvelope = useCallback((envelope: ConsoleEvent) => {
    if (envelope.type === "HUMAN_INPUT_REQUIRED") setDelta((d) => d + 1);
    if (envelope.type === "HUMAN_INPUT_RESOLVED") setDelta((d) => d - 1);
  }, []);

  useConsoleWs(handleEnvelope);

  return Math.max(0, pending.length + delta);
}
