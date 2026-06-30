import { Text as MantineText } from "@mantine/core";

type TextProps = Omit<React.HTMLAttributes<HTMLElement>, "color"> & {
  component?: React.ElementType;
};

export function Text({ component, ...props }: TextProps): React.JSX.Element {
  if (component) {
    // Mantine's polymorphic type requires a literal for `component`; the
    // runtime accepts any ElementType so the cast is safe.
    return <MantineText component={component as "span"} {...props} />;
  }
  return <MantineText {...props} />;
}
