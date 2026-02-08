/**
 * Miscellaneous utility helpers.
 */

/**
 * Extract error message from unknown error type.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Async retry with exponential backoff. Skips retry for 4xx errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      const status = (err as any)?.status;
      if (status && status >= 400 && status < 500) {
        throw err;
      }

      if (attempt === maxRetries - 1) {
        break;
      }

      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
