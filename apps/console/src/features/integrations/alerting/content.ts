import type { AlertSourceKind } from "@nightwarden/shared";

/* What differs between senders is where you paste these and what the sender
   calls its fields. The two values themselves are the same for both, so the
   page draws one set of rows and only the wording around them changes. */
export interface AlertSourceContent {
  // Where these go, and anything the sender asks for that is not one of them.
  where: string;
  warnings: string[];
  rotateDescription: string;
}

export const ALERT_SOURCE_CONTENT: Record<AlertSourceKind, AlertSourceContent> =
  {
    alertmanager: {
      where:
        "Add a webhook receiver to your alertmanager.yml with the URL and secret below, set http_config.authorization.type to Bearer, and point a route at it.",
      warnings: [
        "Leave send_resolved at its default of true. It is how an investigation learns the alert stopped firing, and without it nothing reaches Resolved.",
      ],
      rotateDescription:
        "The current secret stops working immediately, and your Alertmanager stops delivering until you paste the new one into the receiver.",
    },
    grafana: {
      where:
        "In Grafana, go to Alerting, then Contact points, then Add contact point, and choose Webhook. Paste the URL and secret below, with the Authorization header scheme set to Bearer.",
      warnings: [
        "Leave Optional Webhook settings - Custom Payload empty. A custom payload replaces the request body, and NightWarden reads Grafana's default one.",
        "Leave Disable resolved message off. The resolved notification is how an investigation learns the alert stopped firing.",
      ],
      rotateDescription:
        "The current secret stops working immediately, and Grafana stops delivering until you paste the new one into the contact point.",
    },
  };

/* A secret is 4 characters of prefix and 43 of base64url. The masked form runs
   the same length so nothing on the page moves when it is saved. */
export const SECRET_MASK = "•".repeat(47);
