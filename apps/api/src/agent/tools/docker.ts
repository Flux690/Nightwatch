import { z } from "zod";
import { args, executable } from "./exec.js";
import { reason } from "./reason.js";
import { declareTool } from "./schema.js";
import { dockerServers as server } from "./server.js";
import type { Tool } from "./types.js";

// The service's target key, copied verbatim from the <fleet-summary> block or a list
// result - never assembled by hand. The API expands it to the structured identity.
const target = z.string().meta({
  description:
    "The service's target key, copied exactly as it appears in the <fleet-summary> block or in a ListDockerServices result, for example web-01/shop/api. Copy the whole string; never assemble one yourself from parts.",
});

const LIST_SERVICES_INPUT = z.object({ server });
const SERVICE_INPUT = z.object({ target });

const LOGS_INPUT = z.object({
  target,
  tailLines: z.number().int().optional().meta({
    description:
      "How many of the newest lines to search, as a whole number, applied by the engine before contains and excludes. Defaults to 200. This is the size of the search, not the size of the answer: filtering it for a word you expect twice can return two lines out of two hundred searched, and says nothing about the lines it never read. Raise it to look further back.",
  }),
  contains: z.array(z.string()).optional().meta({
    description:
      "Keep only lines holding any one of these words, matched as plain text and ignoring case. Omit it to read the lines as they are.",
  }),
  excludes: z.array(z.string()).optional().meta({
    description:
      "Drop lines holding any one of these words, matched as plain text and ignoring case. Applied before contains, so an excluded line never returns.",
  }),
  since: z.string().optional().meta({
    description:
      "An ISO 8601 timestamp the window starts at. Defaults to the whole tail the engine holds.",
  }),
  until: z.string().optional().meta({
    description:
      "An ISO 8601 timestamp the window ends at, so you can read a past moment rather than only the newest lines. Use it to look at when something started, taking the time from a metric series or from the timestamp on an earlier log line. Defaults to now.",
  }),
  stderrOnly: z.boolean().optional().meta({
    description: "Set this to true to read only stderr and ignore stdout.",
  }),
});

const EVENTS_INPUT = z.object({
  target,
  sinceMinutes: z.number().int().optional().meta({
    description:
      "How many minutes to look back from now, as a whole number. Defaults to 60.",
  }),
});

const RESTART_INPUT = z.object({
  target,
  delaySeconds: z.number().int().optional().meta({
    description:
      "How many seconds to wait before restarting, as a whole number. Defaults to 0, which restarts immediately.",
  }),
  reason,
  estimatedDowntimeSeconds: z.number().int().meta({
    description:
      "How many seconds you expect the service to be unavailable for, as a whole number.",
  }),
});

const EXEC_INPUT = z.object({ target, executable, args, reason });

// Read tools: run unattended, so each is a narrow typed question - never an
// arbitrary command. Safety comes from the shape, not from review.
export const DOCKER_TOOLS: Tool[] = [
  {
    ...declareTool(
      "ListDockerServices",
      "List every Docker service, running and stopped, with its status, image, uptime and health. Call this first when you do not yet know a service's target key, because every service-level Docker tool needs that key.",
      LIST_SERVICES_INPUT,
    ),
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "state",
    on: "runner",
    routeBy: "server",
    platform: "docker",
  },
  {
    ...declareTool(
      "GetDockerLogs",
      "Read a Docker service's recent logs, which are its container's stdout and stderr. Every line comes back with the timestamp the engine recorded against it, so you can line a log up with when the alert fired. Nothing is filtered unless you ask: the newest lines are read, then your own contains and excludes are applied to them.",
      LOGS_INPUT,
    ),
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "logs",
    on: "runner",
    routeBy: "service",
  },
  {
    ...declareTool(
      "GetDockerConfig",
      "Read a Docker service's configuration: its image, restart policy, mounts, ports and healthcheck. Environment variables are reported by name only, never by value, so this cannot tell you what a setting is set to.",
      SERVICE_INPUT,
    ),
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "state",
    on: "runner",
    routeBy: "service",
  },
  {
    ...declareTool(
      "GetDockerStats",
      "Read a Docker service's current resource usage: CPU percentage, memory used against its limit, network traffic and block I/O. These are the values as of now, not a history, so use QueryMetricsRange when you need the shape over time.",
      SERVICE_INPUT,
    ),
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "metric",
    on: "runner",
    routeBy: "service",
  },
  {
    ...declareTool(
      "GetDockerEvents",
      "Read the Docker daemon's lifecycle events for a service, such as start, stop, die and out-of-memory kills. This is how you tell whether a container has been restarting repeatedly rather than running steadily.",
      EVENTS_INPUT,
    ),
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "state",
    on: "runner",
    routeBy: "service",
  },
  {
    ...declareTool(
      "GetDockerProcesses",
      "List the processes running inside a Docker service's container, as docker top does. Use it to see whether the process you expect is the one actually running, and what it is consuming.",
      SERVICE_INPUT,
    ),
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "state",
    on: "runner",
    routeBy: "service",
  },
  {
    ...declareTool(
      "RestartDockerService",
      "Restart a Docker service by restarting its container. The service is briefly unavailable while it comes back.",
      RESTART_INPUT,
    ),
    effect: "write",
    policy: "approve",
    citable: true,
    renderAs: "text",
    on: "runner",
    routeBy: "service",
  },
  {
    ...declareTool(
      "DockerExec",
      "Run one program inside a Docker service's container, as docker exec does. The program runs inside the container and never on the Docker host, and the result carries its exit code, its standard output and its standard error. NightWarden starts no shell, so every argument reaches the program exactly as you write it and characters such as |, > and ; are ordinary text; to use shell syntax, name a shell as the executable and pass the whole script as one argument. The effect of an arbitrary command cannot be known in advance, so every call is treated as a write until a person decides otherwise. Use it to answer a question the typed Docker tools above do not cover, and to apply a fix once you know what the fix is.",
      EXEC_INPUT,
    ),
    effect: "write",
    policy: "approve",
    citable: true,
    renderAs: "terminal",
    on: "runner",
    routeBy: "service",
  },
];
