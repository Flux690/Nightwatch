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
    console.error("[Observer] Docker log stream error:", error);
  });
}
