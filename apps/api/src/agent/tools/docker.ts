import { REASON_PROPERTY } from "./reason.js";
import type { Tool } from "./types.js";

// The service's target key, copied verbatim from the FLEET SUMMARY or a list
// result - never assembled by hand. The API expands it to the structured identity.
const TARGET_PROPERTY = {
  type: "string",
  description:
    "The service's target key, copied exactly as it appears in the FLEET SUMMARY or in a ListDockerServices result, for example docker/web/api. Copy the whole string; never assemble one yourself from parts.",
} as const;

// Consulted only when the target key is ambiguous. Supplied by the model from the fleet
// summary, stripped by the transport before dispatch, never stored, and never part of a key.
const RUNNER_PROPERTY = {
  type: "string",
  description:
    "The name of one Docker host, written exactly as the FLEET SUMMARY lists it. Supply this only when the FLEET SUMMARY marks this target as shared, meaning two hosts advertise the same target key and it would otherwise be ambiguous which one you mean. Omit it in every other case.",
} as const;

// Read tools: run unattended, so each is a narrow typed question - never
// arbitrary shell. Safety comes from the shape, not from review.
export const DOCKER_TOOLS: Tool[] = [
  {
    schema: {
      name: "ListDockerServices",
      description:
        "List every Docker service, running and stopped, with its status, image, uptime and health. Call this first when you do not yet know a service's target key, because every service-level Docker tool needs that key.",
      input_schema: {
        type: "object",
        properties: {
          runner: {
            type: "string",
            description:
              "The name of one Docker host, written exactly as the FLEET SUMMARY lists it. Omit it to read every Docker host at once, which returns one labelled result per host.",
          },
        },
      },
    },
    access: "read",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
  {
    schema: {
      name: "GetDockerLogs",
      description:
        "Read a Docker service's recent logs, which are its container's stdout and stderr. The result is filtered down to error and warning lines plus any line close to the alert's timestamp, so a quiet service can return very little.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          tailLines: {
            type: "number",
            description:
              "How many of the newest lines to search, applied by the engine before contains and excludes. Defaults to 200. This is the size of the search, not the size of the answer: filtering it for a word you expect twice can return two lines out of two hundred searched, and says nothing about the lines it never read. Raise it to look further back.",
          },
          contains: {
            type: "array",
            items: { type: "string" },
            description:
              "Keep only lines holding any one of these words, matched as plain text and ignoring case. Omit it to read the lines as they are.",
          },
          excludes: {
            type: "array",
            items: { type: "string" },
            description:
              "Drop lines holding any one of these words, matched as plain text and ignoring case. Applied before contains, so an excluded line never returns.",
          },
          since: {
            type: "string",
            description:
              "An ISO 8601 timestamp the window starts at. Defaults to the whole tail the engine holds.",
          },
          until: {
            type: "string",
            description:
              "An ISO 8601 timestamp the window ends at, so you can read a past moment rather than only the newest lines. Use it to look at when something started, taking the time from a metric series. Every line within thirty seconds either side of the moment you asked about is kept regardless of the filter. Defaults to now.",
          },
          stderrOnly: {
            type: "boolean",
            description:
              "Set this to true to read only stderr and ignore stdout.",
          },
        },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetDockerConfig",
      description:
        "Read a Docker service's configuration: its image, restart policy, mounts, ports and healthcheck. Environment variables are reported by name only, never by value, so this cannot tell you what a setting is set to.",
      input_schema: {
        type: "object",
        properties: { target: TARGET_PROPERTY, runner: RUNNER_PROPERTY },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetDockerStats",
      description:
        "Read a Docker service's current resource usage: CPU percentage, memory used against its limit, network traffic and block I/O. These are the values as of now, not a history, so use QueryMetricsRange when you need the shape over time.",
      input_schema: {
        type: "object",
        properties: { target: TARGET_PROPERTY, runner: RUNNER_PROPERTY },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetDockerEvents",
      description:
        "Read the Docker daemon's lifecycle events for a service, such as start, stop, die and out-of-memory kills. This is how you tell whether a container has been restarting repeatedly rather than running steadily.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          sinceMinutes: {
            type: "number",
            description:
              "How many minutes to look back from now. Defaults to 60.",
          },
        },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetDockerProcesses",
      description:
        "List the processes running inside a Docker service's container, as docker top does. Use it to see whether the process you expect is the one actually running, and what it is consuming.",
      input_schema: {
        type: "object",
        properties: { target: TARGET_PROPERTY, runner: RUNNER_PROPERTY },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "RestartDockerService",
      description:
        "Restart a Docker service by restarting its container. This changes the Docker host, so calling it pauses you until a human approves or rejects it, and the service is briefly unavailable while it comes back. If the human rejects the call, you will be told so and the restart will not have happened.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          delaySeconds: {
            type: "number",
            description:
              "How many seconds to wait before restarting. Defaults to 0, which restarts immediately.",
          },
          reason: REASON_PROPERTY,
          risk: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "Your own assessment of how much damage this restart could do if it goes wrong. The human sees it labelled as your opinion, beside the facts of the call.",
          },
          estimatedDowntimeSeconds: {
            type: "number",
            description:
              "How many seconds you expect the service to be unavailable for.",
          },
        },
        required: ["target", "reason", "risk", "estimatedDowntimeSeconds"],
      },
    },
    access: "write",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "DockerBash",
      description:
        "Run a shell command inside a Docker service's container, as docker exec does. It runs inside the container and never on the Docker host itself. Because such a command is able to change things, calling it pauses you until a human approves or rejects it, even when the command you are running only reads. Use it to answer questions the typed Docker tools above do not cover, and to apply a fix once you know what the fix is.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          command: {
            type: "array",
            items: { type: "string" },
            description:
              "The command and its arguments, split into an array of strings, for example ['redis-cli', 'info', 'memory']. The human sees exactly this, joined by spaces, and approves that.",
          },
          reason: REASON_PROPERTY,
          risk: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "Your own assessment of how much damage this command could do if it goes wrong. A command that only reads is low. The human sees it labelled as your opinion.",
          },
        },
        required: ["target", "command", "reason", "risk"],
      },
    },
    access: "write",
    on: "runner",
    routeBy: "service",
  },
];
