import {
  Title as MantineTitle,
  type TitleProps as MantineTitleProps,
} from "@mantine/core";

type TitleProps = Omit<React.HTMLAttributes<HTMLHeadingElement>, "color"> & {
  order?: MantineTitleProps["order"];
};

export function Title({ order, ...props }: TitleProps): React.JSX.Element {
  return <MantineTitle order={order} {...props} />;
}
