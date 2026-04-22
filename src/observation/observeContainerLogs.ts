import { PassThrough } from "stream";
import { docker } from "../tools/docker";

export type LogEvent = {
  container: string;
  message: string;
  stream: "stdout" | "stderr";
  timestamp: number;
};

export async function observeContainerLogs(
  containerName: string,
  onLog: (event: LogEvent) => void,
  onError?: (error: Error) => void,
): Promise<void> {
  const container = docker.getContainer(containerName);

  const logStream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    since: Math.floor(Date.now() / 1000),
  });

  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // Use Dockerode's demuxer to properly parse the multiplexed stream
  container.modem.demuxStream(logStream, stdout, stderr);

  const handleStream = (
    stream: PassThrough,
    streamType: "stdout" | "stderr",
  ) => {
    stream.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf-8").trim();
      if (!message) return;

      // Split on newlines in case multiple log lines arrive together
      const lines = message.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        onLog({
          container: containerName,
          message: trimmed,
          stream: streamType,
          timestamp: Date.now(),
        });
      }
    });
  };

  handleStream(stdout, "stdout");
  handleStream(stderr, "stderr");

  logStream.on("error", (error: Error) => {
    if (onError) {
      onError(error);
    } else {
      console.error("[Observer] Docker log stream error:", error);
    }
  });
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Observe container logs with automatic reconnection on stream failure.
 * Uses exponential backoff (1s, 2s, 4s... capped at 30s).
 */
export async function observeWithReconnect(
  containerName: string,
  onLog: (event: LogEvent) => void,
): Promise<void> {
  let delay = 1000;

  const connect = async (): Promise<void> => {
    try {
      await observeContainerLogs(containerName, onLog, () => {
        console.error(
          `[Observer] Stream error for ${containerName}, reconnecting in ${delay}ms`,
        );
        setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      });
      delay = 1000; // Reset on successful connection
    } catch {
      console.error(
        `[Observer] Failed to connect to ${containerName}, retrying in ${delay}ms`,
      );
      setTimeout(() => void connect(), delay);
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
  };

  await connect();
}
