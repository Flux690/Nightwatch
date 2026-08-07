import { useParams } from "@tanstack/react-router";

import { Page } from "@/components/layout/Page";
import { ChatSlot } from "@/components/layout/ChatHost";
import { useSession } from "@/hooks/useSession";

/* The conversation runs the full stage, so this page has no measured body. The
   header names where you are: "New chat" until a session exists, then its
   title. Ticket 016 hangs the history disclosure off that same crumb. */
export function AgentPage(): React.JSX.Element {
  const { id } = useParams({ strict: false });
  const session = useSession(id ?? null);

  return (
    <Page crumbs={[{ label: session?.title ?? "New chat" }]} measure="none">
      {/* The fall belongs to this surface alone, where the conversation has the
          whole stage to fall through. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:stage-fall">
        <ChatSlot className="flex min-h-0 flex-1 flex-col" />
      </div>
    </Page>
  );
}
