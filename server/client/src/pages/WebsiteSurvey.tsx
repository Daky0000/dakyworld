import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Badge, Button } from "../components/ui";
import { useWebsiteSites } from "../components/WebsiteGuard";
import { createPresetsFromSurvey, type BrandPreset } from "../lib/websiteBrandPresets";
import { ColorCodeInput } from "../components/InspectorControls";

/**
 * What a website is made of, read from every page at once.
 *
 * The question this answers is the first one anybody asks about a site they did
 * not build: what is global here? Which block is the header, is that navigation
 * or breadcrumbs, what does this site keep asking people to do, which pages are
 * the same template, and what are its actual colours — not the ones in a brand
 * document nobody has opened since the rebrand.
 *
 * Every answer carries its evidence, because the survey is allowed to be wrong.
 * A region says why it was called a header; a template says what it matched on;
 * a colour says how many times it is used and where. Somebody reading a wrong
 * answer can see *why* it is wrong, which is the difference between a report
 * they correct and one they stop trusting.
 */

type Role = "header" | "footer" | "primary-navigation" | "breadcrumbs" | "sidebar" | "call-to-action" | "newsletter" | "cookie-notice" | "unclassified";
type Kind = "home" | "catalogue" | "product" | "event" | "article" | "contact" | "other";

type Survey = {
  site: { id: string; name: string; publicUrl: string; repo: string | null };
  pages: Array<{ id: string; title: string; path: string }>;
  pagesRead: number;
  elements: Array<{
    key: string;
    name: string;
    role: Role;
    roleReason: string;
    confidence: "high" | "medium";
    reason: string;
    pageIds: string[];
    everywhere: boolean;
  }>;
  callsToAction: Array<{ words: string; href: string | null; kind: "button" | "link"; pageIds: string[]; occurrences: number }>;
  templates: Array<{ kind: Kind; pages: Array<{ pageId: string; title: string; path: string }>; signals: string[] }>;
  palette: {
    colours: Array<{ value: string; uses: number; pageIds: string[]; roles: string[] }>;
    typefaces: Array<{ family: string; uses: number; pageIds: string[] }>;
    sizes: Array<{ value: string; uses: number }>;
    weights: Array<{ value: string; uses: number }>;
    tokens: Array<{ name: string; value: string; uses: number; isColour: boolean }>;
    readFrom: { stylesheets: number; inline: boolean };
  };
  unreadable: Array<{ pageId: string; title: string; path: string; reason: string }>;
  truncated: number;
};

const ROLE_LABEL: Record<Role, string> = {
  header: "Header",
  footer: "Footer",
  "primary-navigation": "Primary navigation",
  breadcrumbs: "Breadcrumbs",
  sidebar: "Sidebar",
  "call-to-action": "Call to action",
  newsletter: "Newsletter signup",
  "cookie-notice": "Cookie notice",
  unclassified: "Repeated block",
};

const KIND_LABEL: Record<Kind, string> = {
  home: "Home",
  catalogue: "Catalogue or listing",
  product: "Product page",
  event: "Event page",
  article: "Article",
  contact: "Contact",
  other: "Other",
};

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <h2 className="font-display text-base tracking-[-.02em]">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{note}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function WebsiteSurvey() {
  const [params, setParams] = useSearchParams();
  const sites = useWebsiteSites();
  const siteId = params.get("site") ?? sites.data?.[0]?.id ?? "";
  const survey = useQuery({
    queryKey: ["website", "survey", siteId],
    enabled: Boolean(siteId),
    queryFn: () => api.get<Survey>(`/website/sites/${siteId}/survey`),
  });

  const qc = useQueryClient();
  const [adoptedMessage, setAdoptedMessage] = useState<string | null>(null);
  const [colorOverrides, setColorOverrides] = useState<Record<string, string>>({});
  const updateSiteColor = async (oldColor: string, nextColor: string) => {
    setColorOverrides(prev => ({ ...prev, [oldColor]: nextColor }));
    if (!siteId || !/^#[\da-f]{6}$/i.test(nextColor)) return;
    try {
      const existing = await api.get<{ options: { colours: string[]; fonts: string[]; aiEnabled: boolean; presets: BrandPreset[] } }>(`/website/sites/${siteId}/design`);
      const baseColours = existing.options.colours.length
        ? existing.options.colours
        : (survey.data?.palette.colours.map(c => c.value) ?? []);
      const replaced = baseColours.map(c => c.toLowerCase() === oldColor.toLowerCase() ? nextColor : c);
      if (!replaced.some(c => c.toLowerCase() === nextColor.toLowerCase())) replaced.unshift(nextColor);
      await api.put(`/website/sites/${siteId}/design`, {
        colours: Array.from(new Set(replaced)).slice(0, 16),
        fonts: existing.options.fonts,
        aiEnabled: existing.options.aiEnabled,
        presets: existing.options.presets,
      });
      void qc.invalidateQueries({ queryKey: ["website", "design", siteId] });
    } catch {
      // Keep local state updated even if background save fails
    }
  };
  const adopt = useMutation({
    mutationFn: async () => {
      if (!survey.data || !siteId) return;
      const presets = createPresetsFromSurvey(survey.data);
      const existing = await api.get<{ options: { colours: string[]; fonts: string[]; aiEnabled: boolean; presets: BrandPreset[] } }>(`/website/sites/${siteId}/design`);
      const mergedPresets = [
        ...existing.options.presets.filter(p => !p.id.startsWith("survey-")),
        ...presets,
      ];
      const newColours = Array.from(new Set([...existing.options.colours, ...survey.data.palette.colours.map(c => colorOverrides[c.value] ?? c.value)])).slice(0, 16);
      const newFonts = Array.from(new Set([...existing.options.fonts, ...survey.data.palette.typefaces.map(t => t.family)])).slice(0, 8);
      await api.put(`/website/sites/${siteId}/design`, {
        colours: newColours,
        fonts: newFonts,
        aiEnabled: existing.options.aiEnabled,
        presets: mergedPresets,
      });
      return { count: presets.length };
    },
    onSuccess: res => {
      setAdoptedMessage(`Adopted ${res?.count ?? 3} brand presets and added discovered colors/fonts to this site.`);
      void qc.invalidateQueries({ queryKey: ["website", "design", siteId] });
    },
    onError: err => {
      setAdoptedMessage(err instanceof Error ? err.message : "Failed to adopt presets.");
    },
  });

  const [showAllRegions, setShowAllRegions] = useState(false);
  const data = survey.data;
  const pageCount = data?.pagesRead ?? 0;

  // A website of any size repeats dozens of blocks. The named regions and the
  // ones on every page are the answer; the rest are true but are not what
  // somebody opened this to find out, so they are a click away rather than
  // thirty rows of "repeats across pages, but nothing in it says what it is".
  const elements = data?.elements ?? [];
  const named = elements.filter((element) => element.role !== "unclassified");
  // A few of the unnamed ones that are on every page, not all of them. Some
  // sites repeat a dozen blocks site-wide that nothing identifies; listing them
  // all pushes the header and the navigation off the top of the screen, which
  // is the opposite of a summary. The rest stay one click away, counted
  // honestly.
  const unnamedEverywhere = elements.filter((element) => element.role === "unclassified" && element.everywhere);
  const worthLeading = [...named, ...unnamedEverywhere.slice(0, 3)];
  const rest = elements.length - worthLeading.length;
  const shown = showAllRegions ? elements : worthLeading;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl tracking-[-.02em]">Site survey</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Every page read at once, to say what is global: the regions that repeat, what the site keeps asking visitors to do, which pages share a
            template, and the colours and type it actually uses. Nothing here asks a model, so it costs nothing and reads the same twice.
          </p>
        </div>
        {(sites.data?.length ?? 0) > 1 && (
          <label className="text-xs text-muted">
            <span className="mb-1 block">Website</span>
            <select
              className="h-9 rounded-xl border border-line bg-white px-2 text-sm text-ink"
              value={siteId}
              onChange={(event) => setParams({ site: event.target.value })}
            >
              {sites.data?.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {survey.isLoading && <p className="text-sm text-muted">Reading every page…</p>}
      {survey.isError && (
        <p className="rounded-2xl border border-warn-line bg-warn-surface p-4 text-sm text-warn-text">
          {survey.error instanceof ApiError ? survey.error.message : "That website could not be surveyed."}
        </p>
      )}

      {data && (
        <>
          <div className="rounded-2xl border border-line bg-white p-5 text-sm">
            <span className="font-semibold text-ink">{pageCount} page{pageCount === 1 ? "" : "s"} read.</span>{" "}
            <span className="text-muted">
              {data.elements.length} repeated region{data.elements.length === 1 ? "" : "s"}, {data.callsToAction.length} repeated action
              {data.callsToAction.length === 1 ? "" : "s"}, {data.templates.length} kind{data.templates.length === 1 ? "" : "s"} of page.
            </span>
            <p className="mt-2 text-muted">
              {data.palette.readFrom.stylesheets > 0
                ? `Colours and type were read from the site's own stylesheets${data.palette.readFrom.inline ? ", and from the pages themselves" : ""}.`
                : "No stylesheet could be read, so the palette below is only what the pages carry themselves."}
            </p>
            {data.truncated > 0 && <p className="mt-2 text-muted">{data.truncated} further pages were not read, to keep this a report rather than a crawl.</p>}
            {data.unreadable.length > 0 && (
              <ul className="mt-3 space-y-1 text-warn-text">
                {data.unreadable.map((page) => (
                  <li key={page.pageId}>
                    <span className="font-semibold">{page.title}</span> ({page.path}) was left out — {page.reason}
                  </li>
                ))}
              </ul>
            )}
            {pageCount === 1 && (
              <p className="mt-2 text-muted">
                One page cannot repeat. Scan more of this website and the global regions and actions become answerable.
              </p>
            )}
          </div>

          <Section title="Global elements" note="Blocks that appear on more than one page. A region on every page is the site's own furniture; one on some pages is a pattern.">
            {data.elements.length === 0 ? (
              <p className="text-sm text-muted">Nothing repeats across these pages.</p>
            ) : (
              <ul className="space-y-3">
                {shown.map((element) => (
                  <li key={element.key} className="rounded-xl border border-line p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={element.role === "unclassified" ? "muted" : "positive"}>{ROLE_LABEL[element.role]}</Badge>
                      {element.everywhere ? (
                        <Badge tone="positive">On every page</Badge>
                      ) : (
                        <Badge tone="muted">
                          {element.pageIds.length} of {pageCount} pages
                        </Badge>
                      )}
                      {element.confidence === "medium" && <Badge tone="warn">Same shape, different words</Badge>}
                    </div>
                    <p className="mt-2 text-sm text-ink">{element.roleReason}</p>
                    <p className="mt-1 text-sm text-muted">{element.reason}</p>
                  </li>
                ))}
              </ul>
            )}
            {rest > 0 && (
              <button
                type="button"
                className="mt-3 text-sm text-blue underline"
                onClick={() => setShowAllRegions((value) => !value)}
              >
                {showAllRegions
                  ? `Hide the ${rest} block${rest === 1 ? "" : "s"} that could not be named`
                  : `Show ${rest} more block${rest === 1 ? "" : "s"} that repeat but could not be named`}
              </button>
            )}
          </Section>

          <Section
            title="What the site asks for"
            note="The same words, linking to the same place, on more than one page. A button repeated everywhere is the site's main ask; a link repeated everywhere is usually its navigation."
          >
            {data.callsToAction.length === 0 ? (
              <p className="text-sm text-muted">No action repeats across these pages.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="pb-2 pr-3 font-medium">Words</th>
                      <th className="pb-2 pr-3 font-medium">Goes to</th>
                      <th className="pb-2 pr-3 font-medium">Kind</th>
                      <th className="pb-2 font-medium">Reach</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.callsToAction.map((action) => (
                      <tr key={`${action.words}|${action.href ?? ""}`} className="border-t border-line">
                        <td className="py-2 pr-3 text-ink">{action.words}</td>
                        <td className="py-2 pr-3 text-muted">{action.href ?? "—"}</td>
                        <td className="py-2 pr-3">
                          <Badge tone={action.kind === "button" ? "positive" : "muted"}>{action.kind === "button" ? "Button" : "Link"}</Badge>
                        </td>
                        <td className="py-2 text-muted">
                          {action.pageIds.length} of {pageCount} pages, {action.occurrences} time{action.occurrences === 1 ? "" : "s"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Kinds of page" note="What each page is, from what is on it rather than from its address. Pages of one kind are usually one template.">
            <ul className="space-y-3">
              {data.templates.map((template) => (
                <li key={template.kind} className="rounded-xl border border-line p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={template.kind === "other" ? "muted" : "positive"}>{KIND_LABEL[template.kind]}</Badge>
                    <span className="text-sm text-muted">
                      {template.pages.length} page{template.pages.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted">{template.signals.join(" ")}</p>
                  <p className="mt-1 text-sm text-ink">{template.pages.map((page) => page.path).join("  ·  ")}</p>
                </li>
              ))}
            </ul>
          </Section>

          {data.palette.tokens.length > 0 && (
            <Section
              title="Design tokens"
              note="Colours and sizes the stylesheet names once and reuses. Where a site has these, they are its design system — changing one changes everywhere it is used."
            >
              <ul className="flex flex-wrap gap-2">
                {data.palette.tokens.slice(0, 40).map((token) => {
                  const currentVal = colorOverrides[token.name] ?? token.value;
                  return (
                    <li key={token.name} className="flex items-center gap-2.5 rounded-xl border border-line px-3 py-2 text-sm">
                      {token.isColour ? (
                        <ColorCodeInput
                          value={currentVal}
                          ariaLabel={`Token ${token.name} color`}
                          onChange={(next) => void updateSiteColor(token.name, next)}
                        />
                      ) : null}
                      <span>
                        <span className="block font-mono text-ink">{token.name}</span>
                        {!token.isColour && <span className="block font-mono text-xs text-muted">{token.value}</span>}
                      </span>
                      <span className="ml-1 text-xs text-muted">{token.uses}&times;</span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          <Section
            title="Colours"
            note="Every colour the pages declare, ordered by how much the site leans on it, with what it is doing. Click any colour picker or hex code to change it."
          >
            {data.palette.colours.length === 0 ? (
              <p className="text-sm text-muted">
                {data.palette.readFrom.stylesheets === 0
                  ? "No stylesheet could be read for these pages, and the pages declare no colours of their own. The design is likely in a stylesheet on another host, which is not fetched."
                  : "The stylesheets were read, and they declare no colours."}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-3">
                {data.palette.colours.slice(0, 24).map((colour) => {
                  const currentVal = colorOverrides[colour.value] ?? colour.value;
                  return (
                    <li key={colour.value} className="flex items-center gap-3 rounded-xl border border-line p-3">
                      <ColorCodeInput
                        value={currentVal}
                        ariaLabel={`Colour ${colour.value}`}
                        onChange={(next) => void updateSiteColor(colour.value, next)}
                      />
                      <span className="text-sm">
                        <span className="block text-xs text-muted">
                          {colour.roles.join(", ")} · {colour.uses} use{colour.uses === 1 ? "" : "s"} on {colour.pageIds.length} page
                          {colour.pageIds.length === 1 ? "" : "s"}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Typography" note="The first family in each stack, which is the one the site means. The rest are what it falls back to.">
            {data.palette.typefaces.length === 0 ? (
              <p className="text-sm text-muted">These pages declare no typefaces of their own.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <ul className="flex flex-wrap gap-2">
                  {data.palette.typefaces.map((face) => (
                    <li key={face.family} className="rounded-xl border border-line px-3 py-2">
                      <span className="text-ink" style={{ fontFamily: face.family }}>
                        {face.family}
                      </span>
                      <span className="ml-2 text-xs text-muted">
                        {face.uses} use{face.uses === 1 ? "" : "s"} on {face.pageIds.length} page{face.pageIds.length === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
                {data.palette.sizes.length > 0 && (
                  <p className="text-muted">
                    <span className="text-ink">Sizes:</span> {data.palette.sizes.slice(0, 12).map((size) => `${size.value} (${size.uses})`).join(", ")}
                  </p>
                )}
                {data.palette.weights.length > 0 && (
                  <p className="text-muted">
                    <span className="text-ink">Weights:</span> {data.palette.weights.slice(0, 12).map((weight) => `${weight.value} (${weight.uses})`).join(", ")}
                  </p>
                )}
              </div>
            )}
          </Section>

          <Section
            title="Adopt into Brand Presets"
            note="Convert the colors, typography, and button styles discovered in this survey into ready-to-use brand presets in the page editor."
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-ink">
                  Generates <strong>Site Headings</strong>, <strong>Primary Button</strong>, and <strong>Card Container</strong> presets from this site's CSS tokens and saves them to this website's design settings.
                </p>
                {adoptedMessage && (
                  <p className="mt-2 text-xs font-semibold text-blue">{adoptedMessage}</p>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                disabled={adopt.isPending || !siteId}
                onClick={() => adopt.mutate()}
              >
                {adopt.isPending ? "Adopting…" : "Adopt as Brand Presets"}
              </Button>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
