import type { AlertGroupContext } from "@nightwarden/shared";

// What a delivery says about itself rather than about any alert in it, so one
// more envelope fact is a field here and not another parameter.
export interface DeliveryContext {
  droppedAlerts: number;
  groupContext: AlertGroupContext | null;
}
