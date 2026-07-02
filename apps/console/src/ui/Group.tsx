import "./Group.css";

import { Group as MantineGroup } from "@mantine/core";

type GroupProps = React.HTMLAttributes<HTMLDivElement>;

export function Group({ className, ...props }: GroupProps): React.JSX.Element {
  return (
    <MantineGroup
      classNames={{ root: className ? `group ${className}` : "group" }}
      {...props}
    />
  );
}
