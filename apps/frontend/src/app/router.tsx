import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useViewportTier } from "../shared/hooks/useViewportTier.js";
import { AuthProvider } from "../features/auth/AuthContext.js";
import { AuthGate } from "./AuthGate.js";
import { METRICS_SOURCE_KINDS } from "@nightwarden/shared";

/* Every page is fetched when its route is first visited, never before. Loaded
   eagerly they were one bundle, so signing in paid for the report renderer and
   the markdown pipeline it will not draw. */
const LAZY = {
  LoginPage: lazyRouteComponent(
    () => import("../features/auth/LoginPage.js"),
    "LoginPage",
  ),
  IntegrationsPage: lazyRouteComponent(
    () => import("../features/integrations/IntegrationsPage.js"),
    "IntegrationsPage",
  ),
  InvestigationsPage: lazyRouteComponent(
    () => import("../features/investigations/InvestigationsPage.js"),
    "InvestigationsPage",
  ),
  InvestigationRecordPage: lazyRouteComponent(
    () => import("../features/investigations/InvestigationRecordPage.js"),
    "InvestigationRecordPage",
  ),
  AgentPage: lazyRouteComponent(
    () => import("../features/session/AgentPage.js"),
    "AgentPage",
  ),
  GitHubConnectPage: lazyRouteComponent(
    () => import("../features/integrations/github/GitHubConnectPage.js"),
    "GitHubConnectPage",
  ),
  AddRunnerPage: lazyRouteComponent(
    () => import("../features/integrations/runners/AddRunnerPage.js"),
    "AddRunnerPage",
  ),
  RunnerListPage: lazyRouteComponent(
    () => import("../features/integrations/runners/RunnerListPage.js"),
    "RunnerListPage",
  ),
  AlertSourcePage: lazyRouteComponent(
    () => import("../features/integrations/alerting/AlertSourcePage.js"),
    "AlertSourcePage",
  ),
  MetricsSourcePage: lazyRouteComponent(
    () => import("../features/integrations/metrics/MetricsSourcePage.js"),
    "MetricsSourcePage",
  ),
  LokiPage: lazyRouteComponent(
    () => import("../features/integrations/loki/LokiPage.js"),
    "LokiPage",
  ),
  SettingsPage: lazyRouteComponent(
    () => import("../features/settings/SettingsPage.js"),
    "SettingsPage",
  ),
} as const;

// Above sign-in, not just above the frontend: finishing a sign-up on a phone
// only to meet this message would be worse than meeting it first.
function RootLayout(): React.JSX.Element {
  const tier = useViewportTier();
  if (tier === "phone") {
    return (
      <div className="flex h-svh flex-col items-center justify-center gap-2 p-6 text-center">
        <h1 className="m-0 text-xl font-semibold">
          NightWarden is built for desktop
        </h1>
        <p className="m-0 text-sm text-muted-foreground">
          An investigation needs a screen at least 768px wide. Open NightWarden
          on a laptop.
        </p>
      </div>
    );
  }
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LAZY.LoginPage,
});

// Pathless layout: nests every authenticated page so AuthGate can redirect
// to /login once, instead of each page route checking auth itself.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AuthGate,
});

// What the agent found while the user slept is what they came for.
const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/investigations" });
  },
});

// What a session is decides its route when it is created, so nothing crosses
// between the two families and nothing has to survive the crossing.
const agentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agent",
  component: LAZY.AgentPage,
});

const agentSessionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agent/$id",
  component: LAZY.AgentPage,
});

const investigationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/investigations/$id",
  component: LAZY.InvestigationRecordPage,
});

const investigationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/investigations",
  component: LAZY.InvestigationsPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations",
  component: LAZY.IntegrationsPage,
});

const githubConnectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/github",
  component: LAZY.GitHubConnectPage,
});

// Docker hosts and Kubernetes clusters are two integrations, not one: they install
// differently and are addressed differently. One list and one wizard serve both,
// parameterized by the platform the route names.
const dockerHostsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/docker",
  component: () => <LAZY.RunnerListPage platform="docker" />,
});

const addDockerHostRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/docker/add",
  component: () => <LAZY.AddRunnerPage platform="docker" />,
});

const kubernetesClustersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/kubernetes",
  component: () => <LAZY.RunnerListPage platform="kubernetes" />,
});

const addKubernetesClusterRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/kubernetes/add",
  component: () => <LAZY.AddRunnerPage platform="kubernetes" />,
});

const alertmanagerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/alerting/alertmanager",
  component: () => <LAZY.AlertSourcePage kind="alertmanager" />,
});

const grafanaAlertingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/alerting/grafana",
  component: () => <LAZY.AlertSourcePage kind="grafana" />,
});

/* One page serves every metrics source, parameterized by the product the
   route names - the shape the two alert sources already use. What differs
   between them is words, which live in METRICS_SOURCE_CONTENT. */
const metricsRoutes = METRICS_SOURCE_KINDS.map((kind) =>
  createRoute({
    getParentRoute: () => appRoute,
    path: `/integrations/metrics/${kind}`,
    component: () => <LAZY.MetricsSourcePage kind={kind} />,
  }),
);

const settingsIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({
      to: "/settings/$section",
      params: { section: "provider" },
    });
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/$section",
  component: LAZY.SettingsPage,
});

const lokiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/loki",
  component: LAZY.LokiPage,
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    agentRoute,
    agentSessionRoute,
    investigationsRoute,
    investigationRoute,
    integrationsRoute,
    githubConnectRoute,
    dockerHostsRoute,
    addDockerHostRoute,
    kubernetesClustersRoute,
    addKubernetesClusterRoute,
    alertmanagerRoute,
    grafanaAlertingRoute,
    ...metricsRoutes,
    lokiRoute,
    settingsIndexRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
