/**
 * Per-incident tool result cache.
 * Avoids redundant Docker API calls across capabilities sharing history.
 * Invalidated after execution mutations (e.g., executePlan).
 */

export class ToolCache {
  private store = new Map<string, unknown>();

  private key(toolName: string, args: Record<string, unknown>): string {
    const sorted = Object.keys(args)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = args[k];
        return acc;
      }, {});
    return `${toolName}:${JSON.stringify(sorted)}`;
  }

  get<T>(toolName: string, args: Record<string, unknown>): T | undefined {
    return this.store.get(this.key(toolName, args)) as T | undefined;
  }

  set(toolName: string, args: Record<string, unknown>, data: unknown): void {
    this.store.set(this.key(toolName, args), data);
  }

  invalidate(): void {
    this.store.clear();
  }
}
