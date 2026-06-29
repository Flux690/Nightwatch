import "./Modal.css";

import {
  Modal as MantineModal,
  type ModalProps as MantineModalProps,
} from "@mantine/core";

type ModalProps = Omit<
  MantineModalProps,
  "unstyled" | "classNames" | "overlayProps"
> & {
  opened: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: string;
};

export function Modal({ children, ...props }: ModalProps): React.JSX.Element {
  return (
    <MantineModal
      unstyled
      classNames={{
        root: "modal",
        header: "modal__header",
        body: "modal__body",
        overlay: "modal__overlay",
        content: "modal__content",
        title: "modal__title",
        close: "modal__close",
      }}
      overlayProps={{
        style: { boxShadow: "var(--shadow-overlay)" },
      }}
      {...props}
    >
      {children}
    </MantineModal>
  );
}
