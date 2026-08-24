import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { ApiError, apiFetch } from "@/shared/api/client";
import { toast } from "@/shared/lib/toast";

/* What every integration page says when a connect attempt never reached us.
   A failure the API answered carries its own words; only the silence needs
   supplying. */
export function connectMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Could not reach the API";
}

/* Disconnecting is the one step every integration performs identically: drop
   the credential, say so, drop the cached status, and leave for the list the
   connection is no longer on. Connecting is not here, because each product
   asks for different fields and a shared shape would only hide that. */
export function useDisconnect<TVars = void>({
  label,
  queryKey,
  endpoint,
}: {
  label: string;
  queryKey: readonly unknown[];
  endpoint: (vars: TVars) => string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (vars: TVars) =>
      apiFetch<void>(endpoint(vars), { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(`${label} disconnected`);
      await queryClient.invalidateQueries({ queryKey });
      void navigate({ to: "/integrations" });
    },
    onError: (err) =>
      toast.show({
        title: "Could not disconnect",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });
}
