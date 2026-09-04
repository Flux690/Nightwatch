import { z } from "zod";
import { dockerServiceIdentitySchema } from "./service-identity.js";

const service = dockerServiceIdentitySchema;

// A program name, never a command line: the runner execs it directly, so a
// space here would name a binary that does not exist.
const executable = z
  .string()
  .min(1)
  .refine((value) => !/\s/.test(value), {
    message: 'must name one program: put arguments in "args"',
  });

// since/until are ISO 8601 and absent means the engine's default.
// contains/excludes filter whole lines, because no engine filters server-side.
export const dockerLogsInputSchema = z.object({
  service,
  tailLines: z.number().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  contains: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
  stderrOnly: z.boolean().optional(),
});
export type DockerLogsInput = z.infer<typeof dockerLogsInputSchema>;

export const dockerConfigInputSchema = z.object({ service });
export type DockerConfigInput = z.infer<typeof dockerConfigInputSchema>;
export const dockerStatsInputSchema = z.object({ service });
export type DockerStatsInput = z.infer<typeof dockerStatsInputSchema>;
export const dockerProcessesInputSchema = z.object({ service });
export type DockerProcessesInput = z.infer<typeof dockerProcessesInputSchema>;

export const dockerEventsInputSchema = z.object({
  service,
  sinceMinutes: z.number().optional(),
});
export type DockerEventsInput = z.infer<typeof dockerEventsInputSchema>;

export const dockerRestartInputSchema = z.object({
  service,
  delaySeconds: z.number().optional(),
  reason: z.string().min(1),
  // Defaulted rather than required: the estimate is advisory, and a missing one
  // must not refuse a restart a human already approved.
  estimatedDowntimeSeconds: z.number().default(0),
});
export type DockerRestartInput = z.infer<typeof dockerRestartInputSchema>;

export const dockerExecInputSchema = z.object({
  service,
  executable,
  args: z.array(z.string()).default([]),
  reason: z.string().min(1),
});
export type DockerExecInput = z.infer<typeof dockerExecInputSchema>;

export const hostDmesgInputSchema = z.object({
  tailLines: z.number().optional(),
  filterLevel: z.enum(["err", "warn", "all"]).optional(),
});
export type HostDmesgInput = z.infer<typeof hostDmesgInputSchema>;

export const hostFileInputSchema = z.object({
  path: z.string().min(1),
  maxLines: z.number().optional(),
});
export type HostFileInput = z.infer<typeof hostFileInputSchema>;
