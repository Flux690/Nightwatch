import { vi } from "vitest";

// jsdom has no EventSource, so tests stub the global with this class.
// `broadcast` reaches every instance since StrictMode mounts two providers.
export class MockEventSource {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSED = 2 as const;

  static latest: MockEventSource | null = null;
  static instances: MockEventSource[] = [];

  readyState: number = MockEventSource.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  constructor(readonly url: string) {
    MockEventSource.latest = this;
    MockEventSource.instances.push(this);
  }

  static reset(): void {
    MockEventSource.latest = null;
    MockEventSource.instances.length = 0;
  }

  push(envelope: object): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  static broadcast(envelope: object): void {
    for (const es of MockEventSource.instances) es.push(envelope);
  }
}
