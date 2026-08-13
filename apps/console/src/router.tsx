import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useViewportTier } from "./hooks/useViewportTier.js";
import { AuthProvider } from "./auth/AuthContext.js";
import { AuthGate } from "./auth/AuthGate.js";
import { LoginPage } from "./pages/LoginPage.js";
import { IntegrationsPage } from "./pages/IntegrationsPage.js";
import { InvestigationsPage } from "./pages/InvestigationsPage.js";
import { InvestigationRecordPage } from "./pages/InvestigationRecordPage.js";
import { AgentPage } from "./pages/AgentPage.js";
import { GitHubConnectPage } from "./pages/GitHubConnectPage.js";
import { AddRunnerPage } from "./pages/AddRunnerPage.js";
import { RunnerListPage } from "./pages/RunnerListPage.js";
import { AlertmanagerPage } from "./pages/AlertmanagerPage.js";
import { PrometheusPage } from "./pages/PrometheusPage.js";
import { LokiPage } from "./pages/LokiPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

// Above sign-in, not just above the console: finishing a sign-up on a phone
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
          An investigation needs a screen at least 768px wide. Open the console
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
  component: LoginPage,
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

// The layout follows the route and nothing else. What a session is decides its
// route when it is created, so nothing ever crosses between the two families and
// no conversation has to survive the crossing.
const agentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agent",
  component: AgentPage,
});

const agentSessionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agent/$id",
  component: AgentPage,
});

const investigationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/investigations/$id",
  component: InvestigationRecordPage,
});

const investigationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/investigations",
  component: InvestigationsPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations",
  component: IntegrationsPage,
});

const githubConnectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/github",
  component: GitHubConnectPage,
});

// Docker hosts and Kubernetes clusters are two integrations, not one: they install
// differently and are addressed differently. One list and one wizard serve both,
// parameterized by the platform the route names.
const dockerHostsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/docker",
  component: () => <RunnerListPage platform="docker" />,
});

const addDockerHostRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/docker/add",
  component: () => <AddRunnerPage platform="docker" />,
});

const kubernetesClustersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/kubernetes",
  component: () => <RunnerListPage platform="kubernetes" />,
});

const addKubernetesClusterRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/kubernetes/add",
  component: () => <AddRunnerPage platform="kubernetes" />,
});

const alertmanagerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/alertmanager",
  component: AlertmanagerPage,
});

const prometheusRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/prometheus",
  component: PrometheusPage,
});

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
  component: SettingsPage,
});

const lokiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/loki",
  component: LokiPage,
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
    prometheusRoute,
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
