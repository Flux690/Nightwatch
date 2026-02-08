import { LogEvent, observeContainerLogs } from "./observeContainerLogs";

export type LogBatch = {
  logs: string[];
  containers: string[];
  triggeredAt: number;
};

// Lifecycle events to IGNORE (graceful shutdown, startup, health checks)
const LIFECYCLE_KEYWORDS = [
  // Signals (graceful shutdown)
  "sigterm",
  "sigint",
  "sighup",
  "signal-handler",
  "received signal",
  "scheduling shutdown",

  // Shutdown messages
  "shutdown",
  "shutting down",
  "stopping",
  "stopped",
  "exiting",
  "bye bye",
  "graceful",
  "gracefully",
  "ready to exit",

  // Startup messages
  "starting",
  "started",
  "ready",
  "listening",
  "accepting connections",
  "server started",
  "initialized",

  // Health/status
  "health check",
  "healthcheck",
  "keepalive",
  "heartbeat",
];

const ERROR_KEYWORDS = [
  "error",
  "exception",
  "fatal",
  "critical",
  "panic",
  "crash",
  "crashed",
  "fail",
  "failed",
  "failure",
  "econnrefused",
  "timeout",
  "timedout",
  "timed out",
  "refused",
  "denied",
  "forbidden",
  "unavailable",
  "unreachable",
  "disconnected",
  "cannot connect",
  "unable to connect",
  "connection lost",
  "oom",
  "out of memory",
  "memory allocation",
  "disk full",
  "no space left",
  "resource exhausted",
  "oomkilled",
  "oom killed",
  "aborted",
  "segfault",
  "core dumped",
  "deadlock",
  "constraint",
  "duplicate key",
  "syntax error",
  "connection pool",
  "nosuchbucket",
  "access denied",
  "invalid credentials",
  "throttling",
  "cannot",
  "unable",
  "could not",
  "invalid",
  "missing",
  "not found",
];

const ERROR_PATTERNS = [
  /\bHTTP[\/\s]\d\.\d\b.+?\b[45]\d{2}\b/,
  /(?:status[_\-\s]?(?:code)?[\s:=]+)[45]\d{2}\b/i,
  /"(?:status|code|statusCode|status_code)"\s*:\s*[45]\d{2}\b/,
  /\b[45]\d{2}\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Gone|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/,
  /"level"\s*:\s*"(error|fatal|critical|panic)"/i,
  /level=(error|fatal|critical|panic)/i,
  /\[(error|fatal|critical|panic)\]/i,
  /ERROR|FATAL|CRITICAL|SEVERE/,
];

function isLifecycleEvent(msg: string): boolean {
  const lower = msg.toLowerCase();
  for (const keyword of LIFECYCLE_KEYWORDS) {
    if (lower.includes(keyword)) return true;
  }
  return false;
}

function hasErrorIndicator(event: LogEvent): boolean {
  const msg = event.message.toLowerCase();

  for (const keyword of ERROR_KEYWORDS) {
    if (msg.includes(keyword)) return true;
  }

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(event.message)) return true;
  }

  return false;
}

function shouldInclude(event: LogEvent): boolean {
  // Step 1: If it's a lifecycle event (shutdown, startup, health), IGNORE
  if (isLifecycleEvent(event.message)) {
    return false;
  }

  // Step 2: stderr without lifecycle keywords is suspicious
  if (event.stream === "stderr") return true;

  // Step 3: Check for actual error indicators
  return hasErrorIndicator(event);
}

export async function startMonitoring(
  containerNames: string[],
  windowMs: number,
  onBatchReady: (batch: LogBatch) => Promise<void> | void,
): Promise<() => void> {
  const MAX_BUFFER_SIZE = 100;

  let buffer: LogEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let isProcessing = false;

  async function flush() {
    if (buffer.length === 0 || isProcessing) return;

    isProcessing = true;
    const batch: LogBatch = {
      logs: buffer.map((e) => `[${e.container}] ${e.message}`),
      containers: [...new Set(buffer.map((e) => e.container))],
      triggeredAt: Date.now(),
    };
    buffer = [];
    timer = null;

    try {
      await onBatchReady(batch);
    } finally {
      isProcessing = false;

      // Process accumulated logs: immediately if buffer full, otherwise wait for more
      if (buffer.length > 0 && !timer) {
        const delay = buffer.length >= MAX_BUFFER_SIZE ? 0 : windowMs;
        timer = setTimeout(() => void flush(), delay);
      }
    }
  }

  function handleLogEvent(event: LogEvent) {
    if (!shouldInclude(event)) return;

    buffer.push(event);

    // Backpressure: force flush when buffer full (preserves all data)
    if (buffer.length >= MAX_BUFFER_SIZE && !isProcessing) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void flush();
      return;
    }

    // Sliding window (debounce): reset timer on each new log
    if (!isProcessing) {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void flush(), windowMs);
    }
  }

  for (const containerName of containerNames) {
    await observeContainerLogs(containerName, handleLogEvent);
  }

  return function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Don't flush on stop - avoids processing during shutdown
  };
}
