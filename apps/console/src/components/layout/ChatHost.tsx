import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useParams } from "@tanstack/react-router";

import { SessionView } from "@/pages/SessionView";

/* The chat's permanent DOM home. It is created once, above the router, and the
   conversation is portaled into it exactly once, so a page that shows the chat
   only re-parents this node. Nothing here ever unmounts, which is what keeps a
   live stream alive across a route change. */
const ChatNodeContext = createContext<HTMLElement | null>(null);

export function ChatHost({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  if (nodeRef.current === null) {
    nodeRef.current = document.createElement("div");
    nodeRef.current.className = "flex min-h-0 flex-1 flex-col";
  }

  // Present on /agent/$id and /investigations/$id, absent elsewhere, which is
  // what tells the conversation it has no session open.
  const { id } = useParams({ strict: false });

  return (
    <ChatNodeContext.Provider value={nodeRef.current}>
      {children}
      {createPortal(<SessionView sessionId={id ?? null} />, nodeRef.current)}
    </ChatNodeContext.Provider>
  );
}

/* Places the conversation here. The node is re-parented into this element, so
   moving the chat between layouts is a DOM move rather than a remount. */
export function ChatSlot({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  const node = useContext(ChatNodeContext);
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null || node === null) return;
    host.appendChild(node);
    return () => {
      if (node.parentElement === host) host.removeChild(node);
    };
  }, [node]);
  return <div ref={hostRef} className={className} />;
}
