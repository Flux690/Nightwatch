// Poll until `fn` is truthy, then return it - for asserting on asynchronously delivered state
// (e.g. buffered WS events) without coupling to timing. In-process dispatch resolves in
// microtasks, so an event may publish before the test captures its session id.
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
