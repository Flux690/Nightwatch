import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequest, ConsoleEvent } from "@nightwatch/shared";
import { apiFetch } from "../api/client.js";
import { useConsoleWs } from "./ConsoleWsProvider.js";

export function useAttentionCount(): number {
  const queryClient = useQueryClient();

  const { data: pending = [] } = useQuery<ApprovalRequest[]>({
    queryKey: ["sessions-pending-human-input"],
    queryFn: () =>
      apiFetch<ApprovalRequest[]>("/api/sessions/pending-human-input"),
  });

  const handleEnvelope = useCallback(
    (envelope: ConsoleEvent) => {
      // The pending list is the source of truth: refetch on an interrupt event rather than
      // keeping a parallel delta, which double-counts once the query independently refetches.
      if (
        envelope.type === "HUMAN_INPUT_REQUIRED" ||
        envelope.type === "HUMAN_INPUT_RESOLVED"
      ) {
        void queryClient.invalidateQueries({
          queryKey: ["sessions-pending-human-input"],
        });
      }
    },
    [queryClient],
  );

  useConsoleWs(handleEnvelope);

  return pending.length;
}
