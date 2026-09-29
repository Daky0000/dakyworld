import { QueryClient, hashKey } from "@tanstack/react-query";
import { ApiError, privateIdentity } from "./api";

export const queryClient = new QueryClient({ defaultOptions: {
  queries: {
    queryKeyHashFn: key => hashKey([privateIdentity(), ...key]),
    staleTime: 30_000, gcTime: 300_000, refetchIntervalInBackground: false,
    retry: (failures, error) => failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    retryDelay: attempt => Math.min(1000 * 2 ** attempt, 10_000),
  },
  mutations: { retry: false },
} });
for (const key of ["settings", "website-config", "capabilities"]) queryClient.setQueryDefaults([key], { staleTime: 300_000 });

/** Use data timestamps, not successful polling timestamps, to slow long-running work. */
export function jobPollInterval(state?: string, startedAt?: string | Date | null): number | false {
  if (!state || !["RUNNING", "QUEUED", "DEPLOYING", "VERIFYING", "COMMITTING", "VALIDATING"].includes(state)) return false;
  return startedAt && Date.now() - new Date(startedAt).getTime() > 60_000 ? 15_000 : 5000;
}
