import "./Stack.css";

import { Stack as MantineStack } from "@mantine/core";

type StackProps = React.HTMLAttributes<HTMLDivElement>;

export function Stack({ className, ...props }: StackProps): React.JSX.Element {
  return (
    <MantineStack
      classNames={{ root: className ? `stack ${className}` : "stack" }}
      {...props}
    />
  );
}
