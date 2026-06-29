import "./Toast.css";

import { Notifications, notifications } from "@mantine/notifications";

import type { NotificationData } from "@mantine/notifications";

export function ToastContainer(): React.JSX.Element {
  return (
    <div aria-live="polite">
      <Notifications unstyled className="toast-container" />
    </div>
  );
}

type ShowProps = Omit<NotificationData, "message"> & {
  message: string;
};

export const toast = {
  show(props: ShowProps): void {
    notifications.show({
      ...props,
      classNames: {
        root: "toast",
        title: "toast__title",
        description: "toast__description",
        closeButton: "toast__close",
      },
    });
  },

  success(message: string): void {
    toast.show({
      message,
      color: "var(--color-status-running)",
      title: "Success",
    });
  },

  error(message: string): void {
    toast.show({
      message,
      color: "var(--color-status-failed)",
      title: "Error",
    });
  },
} as const;
