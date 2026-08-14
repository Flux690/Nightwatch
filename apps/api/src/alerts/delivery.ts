import type { AlertGroupContext } from "@nightwarden/shared";

// Everything a delivery says about itself, as opposed to about any alert in it.
// Travels from the parser to the alert rows, so one more envelope fact is a
// field here rather than another parameter down the chain.
export interface DeliveryContext {
  droppedAlerts: number;
  groupContext: AlertGroupContext | null;
}
