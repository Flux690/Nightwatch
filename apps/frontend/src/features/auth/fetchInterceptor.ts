export function installFetchInterceptor(
  onUnauthorized: () => void,
): () => void {
  const original = window.fetch;
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    if (response.status === 401) onUnauthorized();
    return response;
  };
  return () => {
    window.fetch = original;
  };
}
