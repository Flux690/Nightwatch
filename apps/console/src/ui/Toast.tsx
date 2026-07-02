import "./Toast.css";

import { Notifications, notifications } from "@mantine/notifications";

type ToastVariant = "info" | "success" | "error";

type ShowProps = {
  title?: string;
  message: string;
  variant?: ToastVariant;
};

export function ToastContainer(): React.JSX.Element {
  return (
    <Notifications position="bottom-right" zIndex={300} containerWidth={400} />
  );
}

export const toast = {
  show({ variant = "info", ...props }: ShowProps): void {
    notifications.show({
      ...props,
      classNames: {
        root: `toast toast--${variant}`,
        title: "toast__title",
        description: "toast__description",
        closeButton: "toast__close",
      },
    });
  },

  success(message: string): void {
    toast.show({ message, variant: "success", title: "Success" });
  },

  error(message: string): void {
    toast.show({ message, variant: "error", title: "Error" });
  },

  clean(): void {
    notifications.clean();
  },
} as const;
