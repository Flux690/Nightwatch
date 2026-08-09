import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfig } from "@nightwarden/shared";

import { apiFetch } from "@/api/client";
import { toast } from "@/lib/toast";

const KEY = ["config"];

type ConfigPatch = Partial<Omit<AgentConfig, "providers">>;

export function useConfig(): AgentConfig | undefined {
  const { data } = useQuery<AgentConfig>({
    queryKey: KEY,
    queryFn: () => apiFetch<AgentConfig>("/api/config"),
  });
  return data;
}

// A value that is valid on its own writes as soon as it is committed, so there
// is nothing to save and nothing to discard. A rejected write puts the previous
// value back rather than leaving the screen claiming something it did not save.
export function useConfigAutosave(): (patch: ConfigPatch) => void {
  const queryClient = useQueryClient();
  const { mutate } = useMutation<
    AgentConfig,
    Error,
    ConfigPatch,
    { previous: AgentConfig | undefined }
  >({
    mutationFn: (patch) =>
      apiFetch<AgentConfig>("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const previous = queryClient.getQueryData<AgentConfig>(KEY);
      if (previous) queryClient.setQueryData(KEY, { ...previous, ...patch });
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(KEY, context.previous);
      toast.show({
        title: "Save failed",
        message: error.message,
        variant: "error",
      });
    },
  });
  return mutate;
}
