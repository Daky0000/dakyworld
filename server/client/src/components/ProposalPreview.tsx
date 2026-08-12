import { apiUrl } from "../lib/api";
import type { Proposal } from "../lib/types";
import { Badge, Drawer } from "./ui";

/**
 * The finished proposal, as the client will receive it.
 *
 * The preview is the actual rendered PDF in an iframe rather than an HTML
 * approximation of it. An approximation is a second implementation of the same
 * document, and the two drift — you end up approving a layout on screen and
 * sending a different one. What is shown here is byte-for-byte what downloads.
 *
 * Word is offered alongside because clients ask to edit, and a proposal that
 * has to be retyped into Word to be negotiated arrives at the meeting looking
 * like somebody else's document. Both carry the same letterhead.
 */
export function ProposalPreview({
  proposal,
  open,
  onClose,
}: {
  proposal: Proposal | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!proposal) return null;

  const pdf = apiUrl(`/proposals/${proposal.id}/document.pdf`);
  const docx = apiUrl(`/proposals/${proposal.id}/document.docx`);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title={proposal.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="muted">{proposal.status.toLowerCase()}</Badge>
          <span>{proposal.client?.name ?? proposal.lead?.companyName ?? proposal.lead?.contactName ?? "Unassigned"}</span>
          {proposal.body && <span className="text-ink/40">· argued from {proposal.body.findings.length} findings</span>}
        </span>
      }
      footer={
        <div className="flex flex-wrap items-center gap-3">
          {/* Plain anchors, not fetches: the browser's own download handling is
              better than anything rebuilt with a blob, and the session cookie
              rides along on a same-origin request. */}
          <a
            href={`${pdf}?download=1`}
            download
            className="inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 font-mono text-xs uppercase tracking-[.12em] text-ivory transition hover:bg-ink/90"
          >
            Download PDF
          </a>
          <a
            href={docx}
            download
            className="inline-flex items-center gap-2 border border-ink/20 px-4 py-2 font-mono text-xs uppercase tracking-[.12em] transition hover:border-ink"
          >
            Download Word
          </a>
          <a
            href={pdf}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] uppercase tracking-[.12em] text-bronze"
          >
            Open in a new tab →
          </a>
        </div>
      }
    >
      <iframe
        key={proposal.id}
        src={pdf}
        title={`${proposal.title} — preview`}
        className="h-[74vh] w-full border border-ink/10 bg-ivory"
      />
      <p className="mt-3 text-xs text-ink/40">
        This is the document itself, not a preview of it — what you see here is what downloads and what the client receives.
      </p>
    </Drawer>
  );
}
