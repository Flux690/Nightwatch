import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { AuthProvider } from "./auth/AuthContext.js";
import { AuthGate } from "./auth/AuthGate.js";
import { LoginPage } from "./pages/LoginPage.js";
import { AuditLogPage } from "./pages/AuditLog.js";
import { IntegrationsPage } from "./pages/IntegrationsPage.js";
import { GitHubConnectPage } from "./pages/GitHubConnectPage.js";
import { AddServerPage } from "./pages/AddServerPage.js";
import { RunnerServersPage } from "./pages/RunnerServers.js";
import { AlertmanagerPage } from "./pages/AlertmanagerPage.js";
import { PrometheusPage } from "./pages/PrometheusPage.js";

function RootLayout(): React.JSX.Element {
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

// Inert: Shell owns the one persistent SessionView (id from the URL). These
// routes exist only for URL matching, so / -> /sessions/$id is a prop change.
const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: () => null,
});

const sessionIdRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sessions/$id",
  component: () => null,
});

// Alias only: Shell detects /settings and opens the settings modal over the
// session area, with the persistent SessionView still visible underneath.
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: () => null,
});

const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/audit",
  component: AuditLogPage,
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

// The runner is one integration among several, so its server list and install
// wizard live under /integrations rather than as a top-level fleet section.
const runnerServersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/runner",
  component: RunnerServersPage,
});

const addServerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/integrations/runner/add",
  component: AddServerPage,
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

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    sessionIdRoute,
    settingsRoute,
    auditRoute,
    integrationsRoute,
    githubConnectRoute,
    runnerServersRoute,
    addServerRoute,
    alertmanagerRoute,
    prometheusRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
