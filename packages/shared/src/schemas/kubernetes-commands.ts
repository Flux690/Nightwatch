import { z } from "zod";
import { kubernetesWorkloadIdentitySchema } from "./service-identity.js";

const service = kubernetesWorkloadIdentitySchema;

// A program name, never a command line: the runner execs it directly, so a
// space here would name a binary that does not exist.
const executable = z
  .string()
  .min(1)
  .refine((value) => !/\s/.test(value), {
    message: 'must name one program: put arguments in "args"',
  });

export const k8sWorkloadListInputSchema = z.object({
  namespace: z.string().optional(),
});
export type K8sWorkloadListInput = z.infer<typeof k8sWorkloadListInputSchema>;

// No stderrOnly, because the Kubernetes log API merges the streams. No `until`
// either: it has no end-time parameter, so one would be a filter posing as a query.
export const k8sLogsInputSchema = z.object({
  service,
  tailLines: z.number().optional(),
  since: z.string().optional(),
  contains: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
});
export type K8sLogsInput = z.infer<typeof k8sLogsInputSchema>;

export const k8sConfigInputSchema = z.object({ service });
export type K8sConfigInput = z.infer<typeof k8sConfigInputSchema>;
export const k8sStatsInputSchema = z.object({ service });
export type K8sStatsInput = z.infer<typeof k8sStatsInputSchema>;
export const k8sProcessesInputSchema = z.object({ service });
export type K8sProcessesInput = z.infer<typeof k8sProcessesInputSchema>;
export const k8sRolloutStatusInputSchema = z.object({ service });
export type K8sRolloutStatusInput = z.infer<typeof k8sRolloutStatusInputSchema>;

export const k8sEventsInputSchema = z.object({
  service,
  sinceMinutes: z.number().optional(),
  // Kubernetes Normal events are high-volume; the tool defaults this to true.
  warningsOnly: z.boolean().optional(),
});
export type K8sEventsInput = z.infer<typeof k8sEventsInputSchema>;

// No delaySeconds: a rollout restart is an annotation patch with no delay to honour.
export const k8sRestartInputSchema = z.object({
  service,
  reason: z.string().min(1),
  // Defaulted rather than required: the estimate is advisory, and a missing one
  // must not refuse a restart a human already approved.
  estimatedDowntimeSeconds: z.number().default(0),
});
export type K8sRestartInput = z.infer<typeof k8sRestartInputSchema>;

export const k8sExecInputSchema = z.object({
  service,
  executable,
  args: z.array(z.string()).default([]),
  reason: z.string().min(1),
});
export type K8sExecInput = z.infer<typeof k8sExecInputSchema>;
