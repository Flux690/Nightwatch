import {
  useInfiniteQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  SessionKind,
  SessionListPage,
  SessionListRow,
} from "@nightwarden/shared";
import { apiFetch } from "@/api/client";

// One cache per kind. Investigations and chats are two pages over one table, so
// a shared cache would make either page's "load more" fetch the other's rows.
export function sessionsQueryKey(kind: SessionKind): readonly [string, string] {
  return ["sessions", kind] as const;
}

type Pages = InfiniteData<SessionListPage, number>;

interface UseSessionsResult {
  sessions: SessionListRow[];
  // Answered by the server over every investigation, so a record's place in the
  // queue neither climbs as the operator scrolls nor reads zero on a page that
  // never loaded the list.
  investigationTotal: number;
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

export function useSessions(kind: SessionKind): UseSessionsResult {
  const query = useInfiniteQuery<
    SessionListPage,
    Error,
    Pages,
    ReturnType<typeof sessionsQueryKey>,
    number
  >({
    queryKey: sessionsQueryKey(kind),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiFetch<SessionListPage>(
        `/api/sessions?kind=${kind}&offset=${pageParam}`,
      ),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });

  const first = query.data?.pages[0];
  return {
    // In the order received: the API owns the sort of the set. Arranging what
    // is on screen - the status groups and severity within them - is the
    // page's, because status is derived from a dispatcher SQL cannot see.
    sessions: dedupe(query.data?.pages.flatMap((page) => page.rows) ?? []),
    investigationTotal: first?.investigationTotal ?? 0,
    isLoading: query.isLoading,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

function updatePages(
  queryClient: QueryClient,
  kind: SessionKind,
  update: (pages: SessionListPage[]) => SessionListPage[],
): void {
  queryClient.setQueryData<Pages>(sessionsQueryKey(kind), (prev) =>
    prev === undefined ? prev : { ...prev, pages: update(prev.pages) },
  );
}

// A session just started belongs at the top of the first page, where the API
// would put it. Before that page loads there is nothing to prepend to.
export function prependSession(
  queryClient: QueryClient,
  row: SessionListRow,
): void {
  updatePages(
    queryClient,
    row.investigation ? "investigation" : "chat",
    (pages) =>
      pages.map((page, index) =>
        index === 0 ? { ...page, rows: [row, ...page.rows] } : page,
      ),
  );
}

export function removeSession(
  queryClient: QueryClient,
  kind: SessionKind,
  sessionId: string,
): void {
  updatePages(queryClient, kind, (pages) =>
    pages.map((page) => ({
      ...page,
      rows: page.rows.filter((row) => row.sessionId !== sessionId),
    })),
  );
}

export function renameSession(
  queryClient: QueryClient,
  kind: SessionKind,
  sessionId: string,
  title: string,
): void {
  updatePages(queryClient, kind, (pages) =>
    pages.map((page) => ({
      ...page,
      rows: page.rows.map((row) =>
        row.sessionId === sessionId ? { ...row, title } : row,
      ),
    })),
  );
}
