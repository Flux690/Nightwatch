import "./Accordion.css";

import {
  Accordion as MantineAccordion,
  type AccordionProps,
  type AccordionControlProps,
  type AccordionItemProps,
  type AccordionPanelProps,
} from "@mantine/core";

import { ChevronRight } from "lucide-react";
import { ICON_INLINE } from "./iconProps.js";

export function Accordion(
  props: Omit<
    AccordionProps,
    "classNames" | "chevron" | "disableChevronRotation"
  >,
): React.JSX.Element {
  return (
    <MantineAccordion
      classNames={{
        root: "accordion",
        item: "accordion__item",
        control: "accordion__control",
        chevron: "accordion__chevron",
        label: "accordion__label",
        panel: "accordion__panel",
        content: "accordion__content",
      }}
      chevron={<ChevronRight {...ICON_INLINE} />}
      disableChevronRotation
      transitionDuration={0}
      {...props}
    />
  );
}

export function AccordionItem(props: AccordionItemProps): React.JSX.Element {
  return <MantineAccordion.Item {...props} />;
}

export function AccordionControl(
  props: AccordionControlProps,
): React.JSX.Element {
  return <MantineAccordion.Control {...props} />;
}

export function AccordionPanel(props: AccordionPanelProps): React.JSX.Element {
  return <MantineAccordion.Panel {...props} />;
}
