import { toast as sonnerToast } from "sonner";

type ToastVariant = "info" | "success" | "error";

type ShowProps = {
  title?: string;
  message: string;
  variant?: ToastVariant;
};

export const toast = {
  show({ variant = "info", title, message }: ShowProps): void {
    const emit =
      variant === "success"
        ? sonnerToast.success
        : variant === "error"
          ? sonnerToast.error
          : sonnerToast.info;
    emit(title ?? message, title ? { description: message } : undefined);
  },

  success(message: string): void {
    sonnerToast.success("Success", { description: message });
  },

  error(message: string): void {
    sonnerToast.error("Error", { description: message });
  },

  clean(): void {
    sonnerToast.dismiss();
  },
} as const;
