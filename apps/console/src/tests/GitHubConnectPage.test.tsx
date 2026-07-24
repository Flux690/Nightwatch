import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { GitHubIntegrationStatus } from "@nightwarden/shared";

import { TestProviders } from "./renderWithProviders.js";
import { GitHubConnectPage } from "@/pages/GitHubConnectPage";
import { toast } from "@/lib/toast";

const NOT_CONFIGURED: GitHubIntegrationStatus = {
  configured: false,
  repo: null,
  expiresAt: null,
  validatedAt: null,
};

function configuredStatus(
  repo: string,
  expiresInDays = 90,
): GitHubIntegrationStatus {
  return {
    configured: true,
    repo,
    expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
    validatedAt: new Date().toISOString(),
  };
}

const TWO_REPOS = {
  repos: [
    { fullName: "acme/api", private: true, pushedAt: null, ownerIsOrg: true },
    {
      fullName: "prabhat/dotfiles",
      private: false,
      pushedAt: null,
      ownerIsOrg: false,
    },
  ],
  hasMore: false,
};

interface MockState {
  status: GitHubIntegrationStatus;
  repos: { status: number; body: unknown };
  bind: { status: number; body?: unknown };
  patch: { status: number; body?: unknown };
}

function makeFetchMock(state: MockState) {
  return vi
    .fn<(url: string, init?: RequestInit) => Promise<unknown>>()
    .mockImplementation((url, init) => {
      if (url.includes("/api/integrations/github/repos")) {
        return Promise.resolve({
          ok: state.repos.status < 400,
          status: state.repos.status,
          json: () => Promise.resolve(state.repos.body),
        });
      }
      if (url === "/api/integrations/github") {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            token: string;
            repo: string;
          };
          if (state.bind.status < 400) {
            state.status = configuredStatus(body.repo);
          }
          return Promise.resolve({
            ok: state.bind.status < 400,
            status: state.bind.status,
            json: () => Promise.resolve(state.bind.body ?? state.status),
          });
        }
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as { repo: string };
          if (state.patch.status < 400) {
            state.status = { ...state.status, repo: body.repo };
          }
          return Promise.resolve({
            ok: state.patch.status < 400,
            status: state.patch.status,
            json: () => Promise.resolve(state.patch.body ?? state.status),
          });
        }
        if (init?.method === "DELETE") {
          state.status = NOT_CONFIGURED;
          return Promise.resolve({
            ok: true,
            status: 204,
            json: () => Promise.resolve(undefined),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(state.status),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });
}

/* GitHubConnectPage navigates back to /integrations (disconnect and back
   link), so it renders under a memory router with a stub destination. */
function renderConnectRoute(qc: QueryClient) {
  const rootRoute = createRootRoute();
  const connectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/github",
    component: GitHubConnectPage,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([connectRoute, integrationsRoute]),
    history: createMemoryHistory({ initialEntries: ["/integrations/github"] }),
  });
  return render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
}

function setup(overrides?: Partial<MockState>) {
  const state: MockState = {
    status: NOT_CONFIGURED,
    repos: { status: 200, body: TWO_REPOS },
    bind: { status: 201 },
    patch: { status: 200 },
    ...overrides,
  };
  const fetchMock = makeFetchMock(state);
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  renderConnectRoute(qc);
  return { fetchMock, state };
}

async function validate(
  user: ReturnType<typeof userEvent.setup>,
  token = "github_pat_test",
): Promise<void> {
  await user.type(
    await screen.findByLabelText(/personal access token/i),
    token,
  );
  await user.click(screen.getByRole("button", { name: "Validate" }));
}

async function pickRepo(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<void> {
  await user.click(
    await screen.findByRole("combobox", { name: /repository/i }),
  );
  await user.click(await screen.findByRole("option", { name }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toast.clean();
});

describe("GitHubConnectPage - onboarding (not yet connected)", () => {
  it("shows the token deep link and the always-visible classic-token note", async () => {
    setup();

    const mintLink = await screen.findByRole("link", {
      name: /create token on github/i,
    });
    expect(mintLink).toHaveAttribute(
      "href",
      expect.stringContaining("settings/personal-access-tokens/new"),
    );
    expect(
      screen.getByRole("link", { name: /classic token/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /advanced/i }),
    ).not.toBeInTheDocument();
  });

  it("validates the token, collapses to a plain 'Validated' line, and Change re-opens it", async () => {
    const user = userEvent.setup();
    setup();

    await validate(user);

    expect(await screen.findByText("Validated")).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/personal access token/i),
    ).not.toBeInTheDocument();
    // The description above the field stays, per the field's own label.
    expect(
      screen.getByText(/choose which repository to grant access to/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change" }));

    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
  });

  it("validates, picks a repo, connects, and reflects the connected state in place", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup();

    await validate(user);
    await pickRepo(user, /acme\/api/i);
    await user.click(
      screen.getByRole("button", { name: "Connect repository" }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Disconnect" }),
      ).toBeInTheDocument();
    });

    const bindCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/integrations/github" && init?.method === "POST",
    );
    expect(bindCall).toBeDefined();
    expect(JSON.parse(String(bindCall?.[1]?.body))).toEqual({
      token: "github_pat_test",
      repo: "acme/api",
    });
  });

  it("auto-selects the repository when the token grants exactly one", async () => {
    const user = userEvent.setup();
    setup({
      repos: {
        status: 200,
        body: {
          repos: [
            {
              fullName: "acme/api",
              private: true,
              pushedAt: null,
              ownerIsOrg: true,
            },
          ],
          hasMore: false,
        },
      },
    });

    await validate(user);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect repository" }),
      ).toBeEnabled();
    });
  });

  it("shows the invalid-token ladder step with a regenerate link", async () => {
    const user = userEvent.setup();
    setup({
      repos: {
        status: 401,
        body: { error: "Token invalid or expired", code: "invalid_token" },
      },
    });

    await validate(user);

    expect(
      await screen.findByText(/token invalid or expired/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /regenerate token on github/i }),
    ).toBeInTheDocument();
  });

  it("surfaces the org-approval link when binding 404s on an org-owned repo", async () => {
    const user = userEvent.setup();
    setup({
      bind: {
        status: 404,
        body: {
          error: "GitHub returned 404 for acme/api",
          code: "repo_not_found",
          orgApprovalUrl:
            "https://github.com/organizations/acme/settings/personal-access-token-requests",
        },
      },
    });

    await validate(user);
    await pickRepo(user, /acme\/api/i);
    await user.click(
      screen.getByRole("button", { name: "Connect repository" }),
    );

    const approvalLink = await screen.findByRole("link", {
      name: /review pending token requests/i,
    });
    expect(approvalLink).toHaveAttribute(
      "href",
      "https://github.com/organizations/acme/settings/personal-access-token-requests",
    );
  });
});

describe("GitHubConnectPage - management (already connected)", () => {
  it("shows the validated summary with expiry and the combobox pre-selected to the bound repo, without re-validating", async () => {
    const { fetchMock } = setup({ status: configuredStatus("acme/api", 5) });

    expect(
      await screen.findByText(/validated - expires in 5 days/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/personal access token/i),
    ).not.toBeInTheDocument();

    const combobox = await screen.findByRole("combobox", {
      name: /repository/i,
    });
    expect(combobox).toHaveValue("acme/api");

    const reposCall = fetchMock.mock.calls.find(([url]) =>
      url.includes("/api/integrations/github/repos"),
    );
    expect(reposCall).toBeDefined();
    expect(JSON.parse(String(reposCall?.[1]?.body))).toEqual({ page: 1 });
    expect(
      screen.getByRole("button", { name: "Update repository" }),
    ).toBeDisabled();
  });

  it("changes the repository via the stored token, with no token in the request", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ status: configuredStatus("acme/api") });

    const combobox = await screen.findByRole("combobox", {
      name: /repository/i,
    });
    expect(combobox).toHaveValue("acme/api");

    const reposCall = fetchMock.mock.calls.find(([url]) =>
      url.includes("/api/integrations/github/repos"),
    );
    expect(reposCall).toBeDefined();
    expect(JSON.parse(String(reposCall?.[1]?.body))).toEqual({ page: 1 });

    const updateButton = screen.getByRole("button", {
      name: "Update repository",
    });
    expect(updateButton).toBeDisabled();

    await pickRepo(user, /prabhat\/dotfiles/i);
    expect(updateButton).toBeEnabled();
    await user.click(updateButton);

    const patchCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === "/api/integrations/github" && init?.method === "PATCH",
      );
      expect(call).toBeDefined();
      return call;
    });
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      repo: "prabhat/dotfiles",
    });
  });

  it("changing the token opens a blank field and reconnects with a full bind, not a rebind", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ status: configuredStatus("acme/api") });

    await screen.findByText(/validated/i);
    await user.click(screen.getByRole("button", { name: "Change" }));

    const input = screen.getByLabelText(/personal access token/i);
    expect(input).toHaveValue("");

    await validate(user, "github_pat_new");
    await pickRepo(user, /acme\/api/i);
    await user.click(screen.getByRole("button", { name: "Update repository" }));

    const bindCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === "/api/integrations/github" && init?.method === "POST",
      );
      expect(call).toBeDefined();
      return call;
    });
    expect(JSON.parse(String(bindCall?.[1]?.body))).toEqual({
      token: "github_pat_new",
      repo: "acme/api",
    });
  });

  it("disconnects and returns to the integrations list", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ status: configuredStatus("acme/api") });

    await screen.findByText(/validated/i);
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Disconnect" }),
    );

    await screen.findByText(/integrations destination/i);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/github",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
