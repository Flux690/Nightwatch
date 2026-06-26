import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { AuthProvider } from "./auth/AuthContext.js";
import { AuthGate } from "./auth/AuthGate.js";
import { LoginPage } from "./pages/LoginPage.js";
import { RunnersPage } from "./pages/Runners.js";
import { SettingsPage } from "./pages/Settings.js";
import { AuditLogPage } from "./pages/AuditLog.js";
import { FleetPage } from "./pages/Fleet.js";
import { UnresolvedAlertsPage } from "./pages/UnresolvedAlerts.js";

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

// Pathless layout: every authenticated page nests here so AuthGate can
// redirect to /login (and render nothing in between) without each page
// route needing its own auth check.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AuthGate,
});

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

const runnersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/runners",
  component: RunnersPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsPage,
});

const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/audit",
  component: AuditLogPage,
});

const fleetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fleet",
  component: FleetPage,
});

const unresolvedAlertsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/unresolved-alerts",
  component: UnresolvedAlertsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    sessionIdRoute,
    runnersRoute,
    fleetRoute,
    settingsRoute,
    auditRoute,
    unresolvedAlertsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
