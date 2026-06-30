import "./Center.css";

import { Center as MantineCenter } from "@mantine/core";

type CenterProps = React.HTMLAttributes<HTMLDivElement>;

export function Center({
  className,
  ...props
}: CenterProps): React.JSX.Element {
  return (
    <MantineCenter
      unstyled
      classNames={{ root: className ? `center ${className}` : "center" }}
      {...props}
    />
  );
}
