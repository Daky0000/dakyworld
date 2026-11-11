import type { DemoBrokenFile } from "../lib/types.js";
import { RelativeTime } from "./ui.js";
import { IconAlertTriangle } from "./WebsiteIcons.js";

/**
 * Files a demo's page could not load in somebody's browser.
 *
 * The page reports these itself (server `services/demoBrokenFiles.ts`): a
 * picture the browser throws away after the server sent it shows as a 200 in
 * every log we have, and on 11 Nov 2026 that hid a whole demo's pictures for
 * days. This is where it surfaces instead.
 */

const KIND_LABEL: Record<string, string> = {
  img: "Picture",
  background: "Background picture",
  video: "Video",
  audio: "Audio",
  source: "Video or audio",
  script: "Script",
  link: "Stylesheet",
  font: "Font",
  iframe: "Embedded frame",
};

function fileName(url: string): string {
  if (url.startsWith("font ")) return url.slice(5);
  try {
    const path = new URL(url, "https://x.invalid").pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() || url);
  } catch {
    return url;
  }
}

/** Live preview reports first (they are what is wrong right now), then stored ones not already listed. */
export function mergeBrokenFiles(live: DemoBrokenFile[], stored: DemoBrokenFile[] | undefined): DemoBrokenFile[] {
  const seen = new Set(live.map((file) => file.url));
  return [...live, ...(stored ?? []).filter((file) => !seen.has(file.url))];
}

/** One line for a demo card; the button opens the full list. */
export function BrokenFilesBadge({ files, onOpen }: { files: DemoBrokenFile[] | undefined; onOpen: () => void }) {
  if (!files?.length) return null;
  const last = files.map((file) => file.lastSeenAt).filter(Boolean).sort().pop();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-danger-line bg-danger-surface px-1.5 py-0.5 text-[11px] font-semibold text-danger-text"
    >
      <IconAlertTriangle size={11} />
      <span>
        {files.length} file{files.length === 1 ? "" : "s"} did not load for a visitor
      </span>
      {last && (
        <span className="font-normal">
          · <RelativeTime value={last} />
        </span>
      )}
    </button>
  );
}

export function BrokenFilesPanel({ files }: { files: DemoBrokenFile[] }) {
  if (!files.length) return null;
  return (
    <section className="mb-5 rounded-xl border border-danger-line bg-danger-surface p-4 text-sm text-danger-text" aria-label="Files that did not load">
      <h3 className="flex items-center gap-1.5 font-semibold">
        <IconAlertTriangle size={14} />
        {files.length === 1 ? "A file on this demo did not load" : `${files.length} files on this demo did not load`}
      </h3>
      <p className="mt-1 text-xs">
        A browser opening the page could not load {files.length === 1 ? "it" : "them"}, so the page looked broken to whoever was viewing it.
        If only a few are listed, replace them in the editor or import the demo again with its folder. If every picture is listed, the fault is
        on our server, not in the page.
      </p>
      <ul className="mt-3 space-y-1.5">
        {files.map((file) => (
          <li key={file.url} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="font-semibold">{KIND_LABEL[file.kind] ?? file.kind}</span>
            <span className="max-w-full truncate font-mono" title={file.url}>
              {fileName(file.url)}
            </span>
            <span className="opacity-80">
              {file.lastSeenAt ? (
                <>
                  {file.visits && file.visits > 1 ? `${file.visits} visits, last ` : ""}
                  <RelativeTime value={file.lastSeenAt} />
                </>
              ) : (
                "in the heatmap preview, just now"
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
