import { useEffect, useRef } from "react";
import type { WsEnvelope } from "@nightwatch/shared";

export function useConsoleWs(onMessage: (envelope: WsEnvelope) => void): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/console/connect`;
    const ws = new WebSocket(url);

    ws.onmessage = (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data as string) as WsEnvelope;
        handlerRef.current(envelope);
      } catch {
        // Ignore malformed frames
      }
    };

    return () => {
      ws.close();
    };
  }, []);
}
