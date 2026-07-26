export interface ConsoleEventFrame {
  type: string;
  payload: Record<string, unknown>;
}

export interface ConsoleEventsClient<E> {
  events: E[];
  comments: string[];
  close: () => void;
}

// Once fetch resolves no event can be missed. Always call close() before
// closing the server, or the open stream stalls fastify.close().
export async function connectConsoleEvents<
  E extends { type: string } = ConsoleEventFrame,
>(port: number, session: string): Promise<ConsoleEventsClient<E>> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/console/events`, {
    headers: {
      Accept: "text/event-stream",
      Cookie: `nw_auth=${session}`,
    },
    signal: controller.signal,
  });
  if (res.status !== 200) {
    controller.abort();
    throw new Error(`console events connect failed with status ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    controller.abort();
    throw new Error(`unexpected content-type: ${contentType}`);
  }
  const body = res.body;
  if (!body) throw new Error("SSE response has no body");

  const client: ConsoleEventsClient<E> = {
    events: [],
    comments: [],
    close: () => controller.abort(),
  };

  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              client.events.push(JSON.parse(line.slice("data:".length)) as E);
            } else if (line.startsWith(":")) {
              client.comments.push(line);
            }
          }
          sep = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // The reader ends via AbortController on close(); nothing to clean up.
    }
  })();

  return client;
}

// A tool call whose card reached a phase, as the console would see it. The
// stream carries whole cards, so a completed call is a phase, not an event type.
export function toolCallReached(
  events: ConsoleEventFrame[],
  toolUseId: string,
  phase: "running" | "complete" | "awaiting_human" | "resolved",
): boolean {
  return events.some((e) => {
    if (e.type !== "TRANSCRIPT_ITEM") return false;
    // Frames arrive as parsed JSON; the item shape is the published contract.
    const item = e.payload["item"] as
      { toolUseId?: string; state?: { phase?: string } } | undefined;
    return item?.toolUseId === toolUseId && item.state?.phase === phase;
  });
}
