import type { AlertSourceKind } from "@nightwarden/shared";

// Only text differs between senders. Minting, revealing, rotating and the
// status line are one code path serving every kind.
export interface AlertSourceContent {
  label: string;
  // Named rather than derived from the kind: Alertmanager ships as part of
  // Prometheus and is recognised by that mark.
  logo: string;
  blurb: string;
  setupStep: string;
  confirmStep: string;
  copyLabel: string;
  snippet: (ingestUrl: string, token: string) => string;
  warnings: string[];
  rotateDescription: string;
}

function alertmanagerSnippet(ingestUrl: string, token: string): string {
  return [
    "receivers:",
    "  - name: nightwarden",
    "    webhook_configs:",
    `      - url: '${ingestUrl}'`,
    "        http_config:",
    "          authorization:",
    "            type: Bearer",
    `            credentials: '${token}'`,
  ].join("\n");
}

// Grafana takes a form rather than a file, so each value is labelled.
function grafanaSnippet(ingestUrl: string, token: string): string {
  return [
    `URL                   ${ingestUrl}`,
    `Authorization scheme  Bearer`,
    `Authorization credentials  ${token}`,
  ].join("\n");
}

export const ALERT_SOURCE_CONTENT: Record<AlertSourceKind, AlertSourceContent> =
  {
    alertmanager: {
      label: "Prometheus Alertmanager",
      logo: "/logos/prometheus.svg",
      blurb:
        "Forward alerts from the Alertmanager you already run. One credential covers the whole fleet.",
      setupStep: "1. Paste this receiver into your alertmanager.yml",
      confirmStep: "2. Reload Alertmanager",
      copyLabel: "Copy Alertmanager receiver",
      snippet: alertmanagerSnippet,
      warnings: [
        "Leave send_resolved at its default of true. It is how an investigation learns the alert stopped firing, and without it nothing reaches Resolved.",
      ],
      rotateDescription:
        "The current credential stops working immediately, and your Alertmanager stops delivering until you paste the updated receiver.",
    },
    grafana: {
      label: "Grafana Alerting",
      logo: "/logos/grafana.svg",
      blurb:
        "Forward alerts from Grafana's own alerting. Add a Webhook contact point and point it here.",
      setupStep:
        "1. In Grafana, go to Alerting - Contact points - Add contact point, choose Webhook, and fill in these values",
      confirmStep: "2. Save the contact point and route an alert to it",
      copyLabel: "Copy Grafana webhook settings",
      snippet: grafanaSnippet,
      warnings: [
        "Leave Optional Webhook settings - Custom Payload empty. A custom payload replaces the request body, and NightWarden reads Grafana's default one.",
        "Leave Disable resolved message off. The resolved notification is how an investigation learns the alert stopped firing.",
      ],
      rotateDescription:
        "The current credential stops working immediately, and Grafana stops delivering until you paste the updated credential into the contact point.",
    },
  };
