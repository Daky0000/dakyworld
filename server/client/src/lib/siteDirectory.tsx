import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { SiteSummary } from "./types";

export function useSiteDirectory<T = SiteSummary>() {
  const query = useInfiniteQuery({
    queryKey: ["website", "sites", "directory"], initialPageParam: "",
    queryFn: ({ pageParam, signal }) => api.page<T>(`/website/sites?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  return { ...query, data: query.data?.pages.flatMap(page => page.items) };
}

export function SiteDirectoryMore({ directory }: { directory: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  return directory.hasNextPage ? <button className="my-3 text-sm underline" disabled={directory.isFetchingNextPage} onClick={() => directory.fetchNextPage()}>
    {directory.isFetchingNextPage ? "Loading websites…" : "Load more websites"}
  </button> : null;
}
