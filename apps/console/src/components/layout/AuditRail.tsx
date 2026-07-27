import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import type { RemediationActionRecord } from "@nightwarden/shared";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { apiFetch } from "@/api/client";

export type AuditScope = "all" | "executed" | "rejected" | "pull-requests";

const SCOPES: { value: AuditScope; label: string }[] = [
  { value: "all", label: "All actions" },
  { value: "executed", label: "Executed" },
  { value: "rejected", label: "Rejected" },
  { value: "pull-requests", label: "Pull requests" },
];

export function matchesScope(
  action: RemediationActionRecord,
  scope: AuditScope,
): boolean {
  if (scope === "executed") return action.status === "executed";
  if (scope === "rejected") return action.status === "rejected";
  if (scope === "pull-requests") return action.toolName === "OpenPullRequest";
  return true;
}

/* Audit scopes rail: fixed outcome scopes plus the servers actually present
   in the log. Scope rides the URL so the rail and the table stay two views
   of one address. */
export function AuditRail(): React.JSX.Element {
  const search = useSearch({ strict: false }) as {
    scope?: AuditScope;
    server?: string;
  };
  const activeScope = search.scope ?? "all";
  const activeServer = search.server ?? null;

  // Same query key as the table: one fetch feeds both views.
  const { data: actions = [] } = useQuery<RemediationActionRecord[]>({
    queryKey: ["remediation-actions"],
    queryFn: () =>
      apiFetch<RemediationActionRecord[]>("/api/remediation-actions"),
    refetchInterval: 30_000,
  });

  const servers = [
    ...new Set(
      actions
        .map((a) => a.serviceIdentityKey)
        .filter((k): k is string => k !== null),
    ),
  ].sort();

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel className="text-sm">Scope</SidebarGroupLabel>
        <SidebarMenu className="gap-0.5">
          {SCOPES.map((scope) => (
            <SidebarMenuItem key={scope.value}>
              <SidebarMenuButton
                isActive={activeScope === scope.value && activeServer === null}
                render={
                  <Link to="/audit" search={{ scope: scope.value }}>
                    {scope.label}
                  </Link>
                }
              />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>

      {servers.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel className="text-sm">By server</SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            {servers.map((server) => (
              <SidebarMenuItem key={server}>
                <SidebarMenuButton
                  isActive={activeServer === server}
                  render={
                    <Link to="/audit" search={{ scope: "all", server }}>
                      <span className="truncate font-mono text-sm">
                        {server}
                      </span>
                    </Link>
                  }
                />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}
    </>
  );
}
