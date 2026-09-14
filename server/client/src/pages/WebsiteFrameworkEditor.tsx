import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, apiUrl } from "../lib/api";
import { Badge, Button, RelativeTime } from "../components/ui";
import { SourceFileEditor } from "../components/WebsiteSourceEditor";
import { useWebsiteAccess } from "../components/WebsiteMembers";

/**
 * A framework page, open beside the page itself.
 *
 * The source editor is a file browser, and that is the wrong shape for somebody
 * who clicked Edit next to a page called Pricing and got
 * `app/(marketing)/pricing/page.tsx`. This is the builder shape: the page on the
 * left, its words on the right.
 *
 * The page on the left is the **live** page — the one the host has already
 * built and published. We do not build the project here and we never will: that
 * would mean running somebody's toolchain, and a rendered heading has no
 * reliable way back to the literal it came from once it has been through a loop
 * and a layout. So the frame shows what the public sees, the panel edits the
 * source, and only the elements that could be matched from one to the other are
 * marked as editable. Clicking one puts the caret in its field.
 *
 * What this deliberately does not pretend:
 *
 *  - the frame is not a live canvas. Typing changes the field, not the picture,
 *    and the picture catches up when the host has rebuilt.
 *  - a page that has never been deployed has no picture at all. The fields
 *    still work, and the reason is on screen instead of an empty frame.
 */
type FrameworkPage = {
  page: { id: string; title: string; path: string; filePath: string; url: string };
  site: { id: string; repo: string | null; branch: string; sourceKind: string | null };
  adapter: string;
  fields: Array<{ id: string; label: string; kind: string; value: string; shownOnPage: boolean }>;
  issues: Array<{ message: string; line?: number }>;
  mapping: Array<{ sourceFieldId: string; htmlFieldId: string }>;
  live: { url: string; available: boolean; reason: string | null };
};

export function WebsiteFrameworkEditor() {
  const { pageId = "" } = useParams();
  const [selected, setSelected] = useState<string | null>(null);
  const [frameToken, setFrameToken] = useState(0);
  const [publishedAt, setPublishedAt] = useState<Date | null>(null);
  const [typedOnPage, setTypedOnPage] = useState<{ fieldId: string; value: string; token: number } | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const view = useQuery({ queryKey: ["website", "framework", pageId], queryFn: () => api.get<FrameworkPage>(`/website/pages/${encodeURIComponent(pageId)}/framework`), refetchOnWindowFocus: false });
  const access = useWebsiteAccess(view.data?.site.id ?? "");

  // A click in the frame arrives as the id of an element on the live page. The
  // mapping turns that into the literal in the source file it came from, which
  // is the only thing here that can actually be edited.
  const bySource = useMemo(() => {
    const kinds = new Map((view.data?.fields ?? []).map(field => [field.id, field.kind]));
    const map = new Map<string, string>();
    for (const entry of view.data?.mapping ?? []) {
      // One element can carry two fields — a link's words and its destination.
      // Clicking it means the words far more often than not, so those win and
      // the destination stays a box away rather than stealing the caret.
      const existing = map.get(entry.htmlFieldId);
      if (!existing || (kinds.get(existing) !== "text" && kinds.get(entry.sourceFieldId) === "text")) map.set(entry.htmlFieldId, entry.sourceFieldId);
    }
    return map;
  }, [view.data]);
  // The reverse: which element on the page a given source field is showing as.
  const toElement = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of view.data?.mapping ?? []) if (!map.has(entry.sourceFieldId)) map.set(entry.sourceFieldId, entry.htmlFieldId);
    return map;
  }, [view.data]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; type?: string; id?: string | null; html?: string };
      if (data?.source !== "dakyworld-preview") return;
      if (data.type === "select") { setSelected(data.id ? bySource.get(data.id) ?? null : null); return; }
      if (data.type === "text" && data.id) {
        const fieldId = bySource.get(data.id);
        if (!fieldId) return;
        // The frame sends markup, because on an HTML page a heading may contain
        // a <strong>. A literal in a source file is plain text, so this takes the
        // words and leaves the tags: anything richer than that is a change to the
        // code, and pretending otherwise would commit markup into a JSX string.
        const holder = window.document.createElement("div");
        holder.innerHTML = data.html ?? "";
        const text = (holder.textContent ?? "").replace(/ /g, " ");
        setSelected(fieldId);
        setTypedOnPage(previous => ({ fieldId, value: text, token: (previous?.token ?? 0) + 1 }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bySource]);

  // A field taking the caret in the panel outlines its element on the page, so
  // the two halves of the screen are never describing different things.
  const showOnPage = (fieldId: string) => {
    const elementId = toElement.get(fieldId);
    if (!elementId) return;
    frame.current?.contentWindow?.postMessage({ source: "dakyworld-editor", type: "select", id: elementId }, window.location.origin);
  };

  if (view.isLoading) return <p role="status" className="text-sm text-muted">Opening this page…</p>;
  if (view.error) {
    return <div className="rounded-2xl border border-line bg-white p-6">
      <p role="alert" className="text-sm text-danger-text">{(view.error as Error).message}</p>
      <Link className="mt-4 inline-block text-sm text-blue hover:underline" to="/website">← Back to pages</Link>
    </div>;
  }
  const data = view.data!;
  const shown = data.fields.filter(field => field.shownOnPage).length;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <Link className="text-xs text-blue hover:underline" to="/website">← All pages</Link>
        <h1 className="font-display text-2xl">{data.page.title}</h1>
        <p className="mt-1 break-all text-xs text-muted">{data.page.path} · {data.page.filePath}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {data.site.sourceKind && <Badge tone="muted">{data.site.sourceKind}</Badge>}
        <a href={data.page.url} target="_blank" rel="noreferrer"><Button variant="ghost" size="sm">Open live page</Button></a>
        <Button variant="secondary" size="sm" onClick={() => setFrameToken(token => token + 1)}>Refresh preview</Button>
      </div>
    </div>

    {publishedAt && <p className="rounded-2xl border border-blue/30 bg-white p-4 text-sm text-muted">
      Committed <RelativeTime value={publishedAt.toISOString()} />. Your host is rebuilding; the picture on the left will catch up once that finishes — Refresh preview checks again.
    </p>}

    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section className="rounded-2xl border border-line bg-white p-2" aria-label="The live page">
        {data.live.available ? <>
          <iframe
            key={frameToken}
            ref={frame}
            title={`${data.page.title} as it is published`}
            className="h-[70vh] w-full rounded-xl border border-line bg-white"
            src={apiUrl(`/website/pages/${encodeURIComponent(pageId)}/framework/preview?v=${frameToken}`)}
          />
          <p className="px-2 py-2 text-xs text-muted">
            This is the published page. {shown} of {data.fields.length} {data.fields.length === 1 ? "field" : "fields"} could be matched to something on it: click one to jump to its box, or double click to type on the page itself. The rest of the page — its layout, its styling and anything built by code — stays with the code.
          </p>
        </> : <div className="p-5">
          <h2 className="font-display text-lg">No published page to show yet</h2>
          <p className="mt-2 text-sm text-muted">{data.live.reason ?? "This page has not been deployed."}</p>
          <p className="mt-2 text-sm text-muted">The words are still editable on the right. Once your host has built and published this branch, the page appears here.</p>
        </div>}
      </section>

      <section aria-label="The words on this page">
        {access.data?.capabilities.source === false
          ? <p className="rounded-2xl border border-line bg-white p-5 text-sm text-muted">Editing this page needs a website manager or developer role.</p>
          : <SourceFileEditor
              siteId={data.site.id}
              filePath={data.page.filePath}
              canPublish={access.data?.capabilities.publish === true}
              focusFieldId={selected}
              typedOnPage={typedOnPage}
              onFieldFocus={showOnPage}
              onPublished={() => { setPublishedAt(new Date()); setFrameToken(token => token + 1); }}
            />}
      </section>
    </div>
  </div>;
}
