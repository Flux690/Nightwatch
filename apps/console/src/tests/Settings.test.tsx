import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";

import { SettingsPage } from "../pages/Settings.js";
import { theme, cssVariablesResolver } from "../theme.js";

const CONFIG = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  thinking: "adaptive",
  maxOutputTokens: 32000,
  maxRetries: 2,
  requestTimeoutMs: 120000,
  maxToolCalls: 24,
  hardTimeoutMs: 300000,
  toolTimeoutMs: 15000,
};

const TOKEN = "tok-deploy-abc123";

function setup() {
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/token")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: TOKEN }),
        });
      }
      if (url.includes("/config")) {
        if (init?.method === "PATCH") {
          const patched = { ...CONFIG, ...JSON.parse(init.body as string) };
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(patched),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(CONFIG),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <SettingsPage />
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { fetchMock, clipboardWrite };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SettingsPage", () => {
  it("populates Model and Loop config fields from GET /config on mount", async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByLabelText(/model/i)).toHaveValue("claude-sonnet-4-6");
    });
    expect(screen.getByLabelText(/max output tokens/i)).toHaveValue("32000");
    expect(screen.getByLabelText(/max retries/i)).toHaveValue("2");
    expect(screen.getByLabelText(/max tool calls/i)).toHaveValue("24");
  });

  it("PATCHes /config with only the changed field when Save is clicked", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup();

    const model = await screen.findByLabelText(/model/i);
    await user.clear(model);
    await user.type(model, "claude-opus-4-8");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.[0]).toContain("/config");
      expect(JSON.parse((patchCall?.[1] as RequestInit).body as string)).toEqual(
        { model: "claude-opus-4-8" },
      );
    });
  });

  it("debounces rapid Save clicks into a single PATCH request", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup();

    const model = await screen.findByLabelText(/model/i);
    await user.clear(model);
    await user.type(model, "claude-opus-4-8");

    // Fake timers only for the debounce window; fireEvent issues synchronous
    // clicks so we don't depend on userEvent's own timer scheduling.
    vi.useFakeTimers();
    try {
      const save = screen.getByRole("button", { name: /save/i });
      fireEvent.click(save);
      fireEvent.click(save);
      fireEvent.click(save);

      await vi.advanceTimersByTimeAsync(1000);

      const patchCalls = fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the deployment token as a masked input and copies it on click", async () => {
    const user = userEvent.setup();
    const { clipboardWrite } = setup();

    const tokenInput = await screen.findByLabelText("Deployment token");
    expect(tokenInput).toHaveAttribute("type", "password");
    expect(tokenInput).toHaveValue(TOKEN);

    await user.click(
      screen.getByRole("button", { name: /copy deployment token/i }),
    );
    expect(clipboardWrite).toHaveBeenCalledWith(TOKEN);
  });

  it("shows the full curl install command and copies it on click", async () => {
    const user = userEvent.setup();
    const { clipboardWrite } = setup();

    const expected = `curl -fsSL ${window.location.origin}/install.sh | sh -s -- ${TOKEN}`;

    expect(await screen.findByText(expected)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /copy install command/i }),
    );
    expect(clipboardWrite).toHaveBeenCalledWith(expected);
  });

  it("renders no provider API key field", async () => {
    setup();
    await screen.findByLabelText("Deployment token");
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
  });
});
