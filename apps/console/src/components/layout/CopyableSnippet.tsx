import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
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
      <CodeBlock
        className={cn(
          "max-h-60 border-[0.5px] border-input bg-transparent pr-12",
          // A single line is a field's value, so it stands in a field's box.
          text.includes("\n") ? "p-3" : "flex h-7.5 items-center px-3 py-0",
        )}
      >
        {text}
      </CodeBlock>
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
