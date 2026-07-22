import { Plug } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ICON_DISPLAY } from "@/lib/iconProps";

// The integrations index: the list rail carries the catalog and statuses
// (IntegrationsRail); this main-area panel just points at it.
export function IntegrationsPage(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Plug {...ICON_DISPLAY} />
          </EmptyMedia>
          <EmptyTitle>Integrations</EmptyTitle>
          <EmptyDescription>
            Plug Nightwatch into the stack you already run. Pick an integration
            from the list to connect or manage it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
