import { UnstyledButton as MantineUnstyledButton } from "@mantine/core";

type UnstyledButtonProps = React.ComponentPropsWithoutRef<"button">;

export function UnstyledButton(props: UnstyledButtonProps): React.JSX.Element {
  return <MantineUnstyledButton {...props} />;
}
