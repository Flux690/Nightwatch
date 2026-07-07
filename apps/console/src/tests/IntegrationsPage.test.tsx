import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitHubIntegrationStatus } from "@nightwatch/shared";

import { TestProviders } from "./renderWithProviders.js";
import { IntegrationsPage } from "@/pages/IntegrationsPage";
import { toast } from "@/lib/toast";

const NOT_CONFIGURED: GitHubIntegrationStatus = {
  configured: false,
  repo: null,
  expiresAt: null,
  validatedAt: null,
};

function configuredStatus(expiresInDays: number): GitHubIntegrationStatus {
  return {
    configured: true,
    repo: "acme/api",
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
      if (url.includes("/api/integrations/github")) {
        if (init?.method === "POST") {
          if (state.bind.status < 400) state.status = configuredStatus(90);
          return Promise.resolve({
            ok: state.bind.status < 400,
            status: state.bind.status,
            json: () => Promise.resolve(state.bind.body ?? state.status),
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

function setup(overrides?: Partial<MockState>) {
  const state: MockState = {
    status: NOT_CONFIGURED,
    repos: { status: 200, body: TWO_REPOS },
    bind: { status: 201 },
    ...overrides,
  };
  const fetchMock = makeFetchMock(state);
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <IntegrationsPage />
      </QueryClientProvider>
    </TestProviders>,
  );
  return { fetchMock, state };
}

async function expandAndValidate(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(
    await screen.findByRole("button", { name: /connect github/i }),
  );
  await user.type(
    screen.getByLabelText(/personal access token/i),
    "github_pat_test",
  );
  await user.click(screen.getByRole("button", { name: "Validate" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toast.clean();
});

describe("IntegrationsPage", () => {
  it("offers Connect and expands the in-place flow with the token deep link", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(
      await screen.findByRole("button", { name: /connect github/i }),
    );

    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
    const mintLink = screen.getByRole("link", {
      name: /create token on github/i,
    });
    expect(mintLink).toHaveAttribute(
      "href",
      expect.stringContaining("settings/personal-access-tokens/new"),
    );
    expect(mintLink.getAttribute("href")).toContain("contents=write");
  });

  it("validates the token, lets the user pick a granted repo, and connects", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup();

    await expandAndValidate(user);

    await user.click(await screen.findByRole("radio", { name: /acme\/api/i }));
    await user.click(
      screen.getByRole("button", { name: "Connect repository" }),
    );

    await screen.findByText("Connected");
    expect(screen.getByRole("link", { name: "acme/api" })).toHaveAttribute(
      "href",
      "https://github.com/acme/api",
    );

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

    await expandAndValidate(user);

    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /acme\/api/i })).toBeChecked();
    });
    expect(
      screen.getByRole("button", { name: "Connect repository" }),
    ).toBeEnabled();
  });

  it("shows the invalid-token ladder step with a regenerate link", async () => {
    const user = userEvent.setup();
    setup({
      repos: {
        status: 401,
        body: { error: "Token invalid or expired", code: "invalid_token" },
      },
    });

    await expandAndValidate(user);

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

    await expandAndValidate(user);
    await user.click(await screen.findByRole("radio", { name: /acme\/api/i }));
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

  it("renders the status card with the amber expiry warning and disconnects", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ status: configuredStatus(4.5) });

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/token expires in 5 days/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /regenerate token on github/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Disconnect" }),
    );

    await screen.findByRole("button", { name: /connect github/i });
    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
  });
});
