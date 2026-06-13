// Poll until `fn` returns a truthy value, then return it. For asserting on
// asynchronously delivered state (e.g. WS events buffered into an array) without
// coupling to exact timing. In-process dispatch resolves a run in microtasks, so
// an event can be published before the test captures the session id it will be
// keyed by - buffer every event, then wait for the match here.
export async function waitFor<T>(
  fn: () =>
    | T
    | undefined
    | false
    | null
    | Promise<T | undefined | false | null>,
  opts: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const timeout = opts.timeout ?? 10_000;
  const interval = opts.interval ?? 10;
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
