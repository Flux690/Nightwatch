import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Shell } from "./pages/Shell.js";
import { RunnersPage } from "./pages/Runners.js";
import { SettingsPage } from "./pages/Settings.js";

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});

const sessionIdRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  component: () => null,
});

const runnersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runners",
  component: RunnersPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionIdRoute,
  runnersRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
