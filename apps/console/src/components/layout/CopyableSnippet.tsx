import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ICON_UI } from "@/lib/iconProps";
import { cn } from "@/lib/utils";

export function CopyableSnippet({
  text,
  label,
  actions,
  copyable = true,
  className,
}: {
  text: string;
  label: string;
  // Extra controls rendered inside the corner, before the copy button.
  actions?: React.ReactNode;
  // False hides the copy button for content that must not be copied (masked secrets, placeholders).
  copyable?: boolean;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const revertTimer = useRef<number>(undefined);

  useEffect(() => () => window.clearTimeout(revertTimer.current), []);

  function copy(): void {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    window.clearTimeout(revertTimer.current);
    revertTimer.current = window.setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className={cn("relative", className)}>
      <pre className="block max-h-60 overflow-auto rounded-sm border border-border bg-card p-3 pr-12 font-mono text-sm leading-normal whitespace-pre-wrap break-all text-foreground">
        {text}
      </pre>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
        {actions}
        {copyable && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={copy}
          >
            {copied ? (
              <Check {...ICON_UI} className="text-success" />
            ) : (
              <Copy {...ICON_UI} />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
