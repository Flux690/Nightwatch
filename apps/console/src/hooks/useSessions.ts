import {
  useInfiniteQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type { SessionListPage, SessionListRow } from "@nightwarden/shared";
import { apiFetch } from "@/api/client";

// One query for the whole console: sidebar, attention badge and the optimistic
// row after a chat starts all read this cache, so none of them can disagree.
export const SESSIONS_QUERY_KEY = ["sessions"] as const;

type Pages = InfiniteData<SessionListPage, number>;

export interface UseSessionsResult {
  sessions: SessionListRow[];
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

// Pages are fetched at fixed offsets, so a session that moves between fetches
// can land on two of them. First position wins; it never renders twice.
function dedupe(rows: SessionListRow[]): SessionListRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.sessionId)) return false;
    seen.add(row.sessionId);
    return true;
  });
}

export function useSessions(): UseSessionsResult {
  const query = useInfiniteQuery<
    SessionListPage,
    Error,
    Pages,
    typeof SESSIONS_QUERY_KEY,
    number
  >({
    queryKey: SESSIONS_QUERY_KEY,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiFetch<SessionListPage>(`/api/sessions?offset=${pageParam}`),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });

  return {
    // Rendered in the order received: the API owns the sort, including floating
    // a session that is waiting on a human, so re-sorting here would fight it.
    sessions: dedupe(query.data?.pages.flatMap((page) => page.rows) ?? []),
    isLoading: query.isLoading,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

function updatePages(
  queryClient: QueryClient,
  update: (pages: SessionListPage[]) => SessionListPage[],
): void {
  queryClient.setQueryData<Pages>(SESSIONS_QUERY_KEY, (prev) =>
    prev === undefined ? prev : { ...prev, pages: update(prev.pages) },
  );
}

// A session just started belongs at the top of the first page, where the API
// would put it. Before that page loads there is nothing to prepend to.
export function prependSession(
  queryClient: QueryClient,
  row: SessionListRow,
): void {
  updatePages(queryClient, (pages) =>
    pages.map((page, index) =>
      index === 0 ? { ...page, rows: [row, ...page.rows] } : page,
    ),
  );
}

export function removeSession(
  queryClient: QueryClient,
  sessionId: string,
): void {
  updatePages(queryClient, (pages) =>
    pages.map((page) => ({
      ...page,
      rows: page.rows.filter((row) => row.sessionId !== sessionId),
    })),
  );
}

export function renameSession(
  queryClient: QueryClient,
  sessionId: string,
  title: string,
): void {
  updatePages(queryClient, (pages) =>
    pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) =>
        row.sessionId === sessionId ? { ...row, title } : row,
      ),
    })),
  );
}
