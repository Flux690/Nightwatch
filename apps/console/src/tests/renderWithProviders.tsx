import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ToastContainer } from "@/lib/toast";

/* The production providers with the app's UI context, for deterministic DOM
   assertions. TooltipProvider + SidebarProvider back the shadcn components. */
export function TestProviders({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <ToastContainer />
        {children}
      </SidebarProvider>
    </TooltipProvider>
  );
}
