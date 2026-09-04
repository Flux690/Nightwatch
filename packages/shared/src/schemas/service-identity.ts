import { z } from "zod";

// The nested object every service-routed command carries. Checked here so a
// malformed identity fails at the socket rather than deep in a platform client.
export const dockerServiceIdentitySchema = z.object({
  project: z.string().min(1),
  service: z.string().min(1),
});

export const kubernetesWorkloadIdentitySchema = z.object({
  namespace: z.string().min(1),
  workload: z.string().min(1),
  container: z.string().min(1).optional(),
});
