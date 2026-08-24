import { TooltipProvider } from "@/shared/ui/tooltip";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { Toaster } from "@/shared/ui/sonner";

/* The production providers with the app's UI context, for deterministic DOM assertions: TooltipProvider + SidebarProvider back the shadcn components. */
export function TestProviders({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Toaster />
        {children}
      </SidebarProvider>
    </TooltipProvider>
  );
}
