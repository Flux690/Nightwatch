import { MantineProvider } from "@mantine/core";
import { theme } from "../theme.js";
import { ToastContainer } from "../ui/Toast.js";

/* env="test" is Mantine's documented Vitest setup: the production provider
   with transitions and portals disabled for deterministic DOM assertions. */
export function TestProviders({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <MantineProvider theme={theme} env="test">
      <ToastContainer />
      {children}
    </MantineProvider>
  );
}
