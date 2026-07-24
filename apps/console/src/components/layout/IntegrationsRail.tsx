import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type {
  GitHubIntegrationStatus,
  LokiIntegrationStatus,
  PrometheusIntegrationStatus,
  RunnerRecord,
} from "@nightwarden/shared";
import { Server } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/api/client";

interface IntegrationRow {
  title: string;
  logo: React.ReactNode;
  to: string;
  isLoading: boolean;
  // null when the integration is not set up yet.
  status: string | null;
  // "muted" for in-between states that are configured but not yet proven.
  statusVariant?: "success" | "muted";
}

function RailRow({
  row,
  active,
  onOpen,
}: {
  row: IntegrationRow;
  active: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-label={row.title}
        isActive={active}
        className="h-auto gap-3 py-2"
        onClick={onOpen}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          {row.logo}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{row.title}</span>
          {row.isLoading ? (
            <Spinner className="size-3" />
          ) : (
            <span
              className={cn(
                "truncate text-xs",
                row.status !== null && row.statusVariant !== "muted"
                  ? "text-success"
                  : "text-muted-foreground",
              )}
            >
              {row.status ?? "Not connected"}
            </span>
          )}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/* The integrations list rail: same status semantics the old card grid had,
   grouped Installed / All like an extensions view. Rows open the existing
   config pages in the main area. */
export function IntegrationsRail(): React.JSX.Element {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const { data: github, isLoading: githubLoading } =
    useQuery<GitHubIntegrationStatus>({
      queryKey: ["github-integration"],
      queryFn: () =>
        apiFetch<GitHubIntegrationStatus>("/api/integrations/github"),
    });

  const { data: runners, isLoading: runnersLoading } = useQuery<RunnerRecord[]>(
    {
      queryKey: ["runners"],
      queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
    },
  );

  const { data: ingest, isLoading: ingestLoading } = useQuery<{
    configured: boolean;
    lastReceivedAt: string | null;
  }>({
    queryKey: ["alertmanager-integration"],
    queryFn: () =>
      apiFetch<{ configured: boolean; lastReceivedAt: string | null }>(
        "/api/integrations/alertmanager",
      ),
  });

  const { data: prometheus, isLoading: prometheusLoading } =
    useQuery<PrometheusIntegrationStatus>({
      queryKey: ["prometheus-integration"],
      queryFn: () =>
        apiFetch<PrometheusIntegrationStatus>("/api/integrations/prometheus"),
    });

  const { data: loki, isLoading: lokiLoading } =
    useQuery<LokiIntegrationStatus>({
      queryKey: ["loki-integration"],
      queryFn: () => apiFetch<LokiIntegrationStatus>("/api/integrations/loki"),
    });

  const connectedRunners = (runners ?? []).filter((r) => r.hostname !== null);

  const rows: IntegrationRow[] = [
    {
      title: "NightWarden Runner",
      logo: <Server className="size-5 text-muted-foreground" />,
      // An empty fleet routes straight to the add-server wizard.
      to:
        connectedRunners.length > 0
          ? "/integrations/runner"
          : "/integrations/runner/add",
      isLoading: runnersLoading,
      status:
        connectedRunners.length > 0
          ? `${connectedRunners.length} ${connectedRunners.length === 1 ? "server" : "servers"}`
          : null,
    },
    {
      title: "Alertmanager",
      logo: <img src="/logos/alertmanager.svg" alt="" className="size-5" />,
      to: "/integrations/alertmanager",
      isLoading: ingestLoading,
      status:
        ingest?.configured !== true
          ? null
          : ingest.lastReceivedAt !== null
            ? "Receiving"
            : "Waiting for first alert",
      statusVariant: ingest?.lastReceivedAt !== null ? "success" : "muted",
    },
    {
      title: "Prometheus",
      logo: <img src="/logos/prometheus.svg" alt="" className="size-5" />,
      to: "/integrations/prometheus",
      isLoading: prometheusLoading,
      status: prometheus?.configured === true ? "Connected" : null,
    },
    {
      title: "Loki",
      logo: <img src="/logos/loki.svg" alt="" className="size-5" />,
      to: "/integrations/loki",
      isLoading: lokiLoading,
      status: loki?.configured === true ? "Connected" : null,
    },
    {
      title: "GitHub",
      logo: <img src="/logos/github.svg" alt="" className="size-5" />,
      to: "/integrations/github",
      isLoading: githubLoading,
      status: github?.configured === true ? "Connected" : null,
    },
  ];

  const installed = rows.filter((r) => r.status !== null);
  const available = rows.filter((r) => r.status === null);

  function group(label: string, items: IntegrationRow[]): React.JSX.Element {
    return (
      <SidebarGroup>
        <SidebarGroupLabel className="text-sm">{label}</SidebarGroupLabel>
        <SidebarMenu className="gap-0.5">
          {items.map((row) => (
            <RailRow
              key={row.title}
              row={row}
              active={pathname.startsWith(row.to)}
              onOpen={() => void navigate({ to: row.to })}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>
    );
  }

  return (
    <>
      {installed.length > 0 && group("Installed", installed)}
      {available.length > 0 && group("All integrations", available)}
    </>
  );
}
