import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ICON_UI } from "@/lib/iconProps";
import { cn } from "@/lib/utils";

export function CopyableSnippet({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}): React.JSX.Element {
  function copy(): void {
    void navigator.clipboard.writeText(text);
  }
  return (
    <div className={cn("flex flex-nowrap items-start gap-2", className)}>
      <pre className="block max-h-60 flex-1 overflow-auto rounded-sm border border-border bg-card p-3 font-mono text-sm leading-normal whitespace-pre-wrap break-all text-foreground">
        {text}
      </pre>
      <Button variant="ghost" size="icon" aria-label={label} onClick={copy}>
        <Copy {...ICON_UI} />
      </Button>
    </div>
  );
}
