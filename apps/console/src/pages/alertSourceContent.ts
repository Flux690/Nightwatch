import type { AlertSourceKind } from "@nightwarden/shared";

// One value the user copies into the sender, on its own so a live credential
// never has to travel inside a block someone might paste into a ticket.
export interface AlertSourceField {
  label: string;
  value: string;
}

export interface AlertSourceContent {
  label: string;
  // Named rather than derived from the kind: Alertmanager ships as part of
  // Prometheus and is recognised by that mark.
  logo: string;
  blurb: string;
  setupStep: string;
  confirmStep: string;
  fields: (ingestUrl: string) => AlertSourceField[];
  // Only for a sender whose setup is a file to edit. The credential is a
  // placeholder here, never the real one.
  template?: (ingestUrl: string) => { label: string; text: string };
  warnings: string[];
  rotateDescription: string;
}

const CREDENTIAL_PLACEHOLDER = "<paste your credential here>";

function alertmanagerTemplate(ingestUrl: string): {
  label: string;
  text: string;
} {
  return {
    label: "Copy Alertmanager receiver",
    text: [
      "receivers:",
      "  - name: nightwarden",
      "    webhook_configs:",
      `      - url: '${ingestUrl}'`,
      "        http_config:",
      "          authorization:",
      "            type: Bearer",
      `            credentials: '${CREDENTIAL_PLACEHOLDER}'`,
    ].join("\n"),
  };
}

export const ALERT_SOURCE_CONTENT: Record<AlertSourceKind, AlertSourceContent> =
  {
    alertmanager: {
      label: "Prometheus Alertmanager",
      logo: "/logos/prometheus.svg",
      blurb:
        "Forward alerts from the Alertmanager you already run. One credential covers the whole fleet.",
      setupStep: "1. Add this receiver to your alertmanager.yml",
      confirmStep: "2. Reload Alertmanager",
      fields: (ingestUrl) => [{ label: "Ingest URL", value: ingestUrl }],
      template: alertmanagerTemplate,
      warnings: [
        "Leave send_resolved at its default of true. It is how an investigation learns the alert stopped firing, and without it nothing reaches Resolved.",
      ],
      rotateDescription:
        "The current credential stops working immediately, and your Alertmanager stops delivering until you paste the new one into the receiver.",
    },
    grafana: {
      label: "Grafana Alerting",
      logo: "/logos/grafana.svg",
      blurb:
        "Forward alerts from Grafana's own alerting. Add a Webhook contact point and point it here.",
      setupStep:
        "1. In Grafana, go to Alerting - Contact points - Add contact point, choose Webhook, and fill in these values",
      confirmStep: "2. Save the contact point and route an alert to it",
      // A form, not a file, so there is nothing to paste as a block.
      fields: (ingestUrl) => [
        { label: "URL", value: ingestUrl },
        { label: "Authorization scheme", value: "Bearer" },
      ],
      warnings: [
        "Leave Optional Webhook settings - Custom Payload empty. A custom payload replaces the request body, and NightWarden reads Grafana's default one.",
        "Leave Disable resolved message off. The resolved notification is how an investigation learns the alert stopped firing.",
      ],
      rotateDescription:
        "The current credential stops working immediately, and Grafana stops delivering until you paste the new one into the contact point.",
    },
  };
