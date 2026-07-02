import "./Loader.css";

import { Loader as MantineLoader } from "@mantine/core";

type LoaderProps = {
  className?: string;
  "aria-label"?: string;
};

export function Loader(props: LoaderProps): React.JSX.Element {
  return <MantineLoader classNames={{ root: "loader" }} {...props} />;
}
