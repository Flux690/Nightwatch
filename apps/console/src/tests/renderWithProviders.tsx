import { HeadlessMantineProvider } from "@mantine/core";
import { ToastContainer } from "../ui/Toast.js";

export function TestProviders({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <HeadlessMantineProvider>
      <ToastContainer />
      {children}
    </HeadlessMantineProvider>
  );
}
