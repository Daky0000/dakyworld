import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import type { AppSettings } from "./lib/types";
import { PublishingPanels } from "./components/PublishingSettings";

/**
 * Settings → Publishing on its own, for checks/browser/publishingSettings.mjs.
 * The page reads only `settings.publishing`, which the check answers.
 */
export function PublishingHarness() {
  const { data } = useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => api.get<AppSettings>("/settings", signal) });
  return data ? <PublishingPanels settings={data} /> : <p>Loading…</p>;
}
