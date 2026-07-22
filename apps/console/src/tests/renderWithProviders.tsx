import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/lib/theme";

/* The production providers with the app's UI context, for deterministic DOM assertions: ThemeProvider + TooltipProvider + SidebarProvider back the shadcn components. */
export function TestProviders({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <SidebarProvider>
          <Toaster />
          {children}
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
