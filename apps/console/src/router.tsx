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
import { AddServerPage } from "./pages/AddServerPage.js";
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

/* Alias only: Shell detects /settings and opens the settings modal over the
   session area, so the URL keeps working without a dedicated page. */
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

const fleetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fleet",
  component: FleetPage,
});

const addServerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fleet/add",
  component: AddServerPage,
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
    fleetRoute,
    addServerRoute,
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
