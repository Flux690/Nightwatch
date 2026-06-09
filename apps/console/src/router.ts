import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { RunnersPage } from "./pages/Runners.js";
import { SessionsEmpty, SessionsLayout } from "./pages/Sessions.js";
import { NewSessionPage } from "./pages/Sessions.js";
import { SessionTranscript } from "./pages/SessionTranscript.js";
import { SettingsPage } from "./pages/Settings.js";

const rootRoute = createRootRoute({ component: Outlet });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/sessions" });
  },
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: SessionsLayout,
});

const sessionsIndexRoute = createRoute({
  getParentRoute: () => sessionsRoute,
  path: "/",
  component: SessionsEmpty,
});

const newSessionRoute = createRoute({
  getParentRoute: () => sessionsRoute,
  path: "new",
  component: NewSessionPage,
});

const sessionIdRoute = createRoute({
  getParentRoute: () => sessionsRoute,
  path: "$id",
  component: SessionTranscript,
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
  sessionsRoute.addChildren([
    sessionsIndexRoute,
    newSessionRoute,
    sessionIdRoute,
  ]),
  runnersRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
