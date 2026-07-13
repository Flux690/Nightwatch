import { vi, type Mock } from "vitest";
import { createContractFakeProvider } from "./contract-fake-provider.js";

// Complete double for ../llm/factory.js: tests script the investigation via
// mockCreateProvider; the title door defaults to empty text so the real
// generateSessionTitle path runs and skips cleanly (no write, no event).
export const mockCreateProvider: Mock = vi.fn();
export const mockCreateTitleProvider: Mock = vi.fn(() =>
  createContractFakeProvider([{ toolUses: [], text: "" }]),
);

export const createProvider: Mock = mockCreateProvider;
export const createTitleProvider: Mock = mockCreateTitleProvider;
