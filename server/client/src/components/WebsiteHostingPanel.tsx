import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button, Card, Notice } from "./ui";

/**
 * Where a customer's website actually lives, and how to put their own domain
 * on it.
 *
 * Both halves of this used to be missing rather than hidden: a site with no
 * GitHub repository had nowhere to publish to, and there was no such thing as
 * a custom domain. The panel is deliberately plain about which of the two
 * addresses is live, because "is my website up?" is the only question a
 * customer is really asking on this screen.
 */

type Hosting = {
  hostedEnabled: boolean;
  hostedSlug: string;
  hostDomain: string | null;
  hostedUrl: string | null;
  publishesToRepository: boolean;
  publishedPages: number;
  customDomain: string | null;
  customDomainVerifiedAt: string | null;
  dnsInstructions: {
    txt: { name: string; value: string | null };
    cname: { name: string; value: string } | null;
  } | null;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 rounded-lg bg-ink/[.03] px-3 py-2 font-mono text-xs">
      <span className="min-w-16 font-sans text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="break-all text-ink">{value}</span>
    </div>
  );
}

export function WebsiteHostingPanel({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const [domain, setDomain] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const hosting = useQuery({
    queryKey: ["website", "hosting", siteId],
    queryFn: () => api.get<Hosting>(`/website/sites/${siteId}/hosting`),
  });

  const save = useMutation({
    mutationFn: (next: string | null) => api.put(`/website/sites/${siteId}/hosting/domain`, { domain: next }),
    onSuccess: () => {
      setMessage(null);
      void qc.invalidateQueries({ queryKey: ["website", "hosting", siteId] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const verify = useMutation({
    mutationFn: () => api.post<{ verified: boolean; found: string[] }>(`/website/sites/${siteId}/hosting/verify`, {}),
    onSuccess: (result) => {
      setMessage(
        result.verified
          ? "Verified. Your domain is now serving this website."
          : "The record is not visible yet. DNS can take up to an hour to spread — try again shortly.",
      );
      void qc.invalidateQueries({ queryKey: ["website", "hosting", siteId] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  if (hosting.isLoading) return <p className="text-sm text-muted">Loading hosting…</p>;
  if (hosting.isError) return <Notice tone="warn">{(hosting.error as Error).message}</Notice>;
  const data = hosting.data!;

  return (
    <Card className="space-y-5 p-6">
      <div>
        <h2 className="font-display text-lg font-medium text-ink">Where this website is served</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          {data.publishesToRepository
            ? "Publishing commits to your GitHub repository, and the address below serves the same pages from here — useful while a domain is still pointing elsewhere."
            : "This website is hosted here. Publishing puts the page live at the address below straight away."}
        </p>
      </div>

      <div className="space-y-2">
        {data.hostedUrl ? (
          <Row label="Address" value={data.hostedUrl} />
        ) : (
          <Notice tone="warn">
            No hosting address yet. This appears once the first page is published, or once a hosting domain is configured
            on the server.
          </Notice>
        )}
        <Row label="Published" value={`${data.publishedPages} page${data.publishedPages === 1 ? "" : "s"}`} />
      </div>

      <div className="border-t border-line pt-5">
        <h3 className="text-sm font-semibold text-ink">Your own domain</h3>
        {data.customDomain ? (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm text-ink">{data.customDomain}</span>
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  data.customDomainVerifiedAt ? "bg-ok-surface text-ok-text" : "bg-warn-surface text-warn-text"
                }`}
              >
                {data.customDomainVerifiedAt ? "Verified and serving" : "Waiting for DNS"}
              </span>
            </div>

            {!data.customDomainVerifiedAt && data.dnsInstructions && (
              <div className="space-y-2">
                <p className="text-sm text-muted">
                  Add these two records at whoever manages your domain, then press Verify. The TXT record proves the
                  domain is yours; the CNAME is what points it here.
                </p>
                <Row label="TXT" value={`${data.dnsInstructions.txt.name} → ${data.dnsInstructions.txt.value ?? ""}`} />
                {data.dnsInstructions.cname && (
                  <Row
                    label="CNAME"
                    value={`${data.dnsInstructions.cname.name} → ${data.dnsInstructions.cname.value}`}
                  />
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              {!data.customDomainVerifiedAt && (
                <Button size="sm" disabled={verify.isPending} onClick={() => verify.mutate()}>
                  {verify.isPending ? "Checking DNS…" : "Verify"}
                </Button>
              )}
              <Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => save.mutate(null)}>
                Remove domain
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-3">
            <input
              className="min-w-64 flex-1 rounded-xl border border-line bg-cream px-3 py-2 text-sm"
              placeholder="example.com"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
            />
            <Button size="sm" disabled={!domain.trim() || save.isPending} onClick={() => save.mutate(domain.trim())}>
              {save.isPending ? "Saving…" : "Add domain"}
            </Button>
          </div>
        )}
        {message && <p className="mt-3 text-sm text-muted">{message}</p>}
      </div>
    </Card>
  );
}
