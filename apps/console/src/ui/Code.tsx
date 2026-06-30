import "./Code.css";

import { Code as MantineCode } from "@mantine/core";

type CodeProps = React.HTMLAttributes<HTMLElement> & {
  block?: boolean;
};

export function Code({
  block,
  className,
  ...props
}: CodeProps): React.JSX.Element {
  return (
    <MantineCode
      unstyled
      block={block}
      classNames={{
        root: className ? `code ${className}` : "code",
      }}
      {...props}
    />
  );
}
