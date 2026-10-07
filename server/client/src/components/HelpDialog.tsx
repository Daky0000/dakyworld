import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useOverlay } from "./ui";

/**
 * "Talk to a person" — the company's email and phone from System settings,
 * WhatsApp when a number has been set there for it, and the setup guide.
 * Server: GET /api/website/help (services/websiteSetupAssistance.ts).
 */
type HelpContacts = {
  name: string;
  email: string;
  phone: string;
  whatsapp: { display: string; link: string } | null;
  guide: string;
};

export function useHelpContacts(enabled = true) {
  return useQuery({ queryKey: ["website", "help"], enabled, staleTime: 5 * 60_000, queryFn: ({ signal }) => api.get<HelpContacts>("/website/help", signal) });
}

const linkClass = "flex w-full items-center justify-between gap-3 rounded-xl border border-line px-4 py-3 text-sm text-ink transition hover:border-line-strong hover:bg-sunken";

export function HelpDialog({ open, onClose, context }: { open: boolean; onClose: () => void; context?: string }) {
  const contacts = useHelpContacts(open);
  const overlay = useOverlay(open, onClose);
  if (!open) return null;
  const message = encodeURIComponent(`Hello, I need help with my website on DakyX${context ? ` (${context})` : ""}.`);
  const data = contacts.data;
  return (
    <div className="fixed inset-0 z-[10002] flex items-end justify-center bg-ink/40 p-4 sm:items-center" onClick={onClose}>
      <div
        ref={overlay}
        tabIndex={-1}
        data-os-overlay="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        className="w-full max-w-md rounded-2xl border border-line bg-white p-5 text-ink shadow-2xl outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="help-title" className="font-display text-lg">Talk to a person</h2>
            <p className="mt-1 text-sm text-muted">A real person at {data?.name ?? "DakyXTech"} answers, usually the same working day.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-line px-3 py-1 text-[11px] font-bold text-muted hover:text-ink">Close</button>
        </div>
        {contacts.isLoading && <p className="mt-4 text-sm text-muted" role="status">Loading…</p>}
        {data && (
          <div className="mt-4 space-y-2">
            {data.whatsapp && (
              <a className={linkClass} href={`${data.whatsapp.link}?text=${message}`} target="_blank" rel="noreferrer">
                <span><strong>WhatsApp</strong> <span className="text-muted">· {data.whatsapp.display}</span></span>
                <span aria-hidden>↗</span>
              </a>
            )}
            <a className={linkClass} href={`mailto:${data.email}?subject=${encodeURIComponent("Help with my website")}&body=${message}`}>
              <span><strong>Email</strong> <span className="text-muted">· {data.email}</span></span>
              <span aria-hidden>↗</span>
            </a>
            <a className={linkClass} href={`tel:${data.phone.replace(/\s/g, "")}`}>
              <span><strong>Call</strong> <span className="text-muted">· {data.phone}</span></span>
              <span aria-hidden>↗</span>
            </a>
            <a className={linkClass} href={data.guide} target="_blank" rel="noreferrer">
              <span><strong>Setup guide</strong> <span className="text-muted">· every step, written down</span></span>
              <span aria-hidden>↗</span>
            </a>
          </div>
        )}
        {contacts.error && (
          <p className="mt-4 text-sm text-muted">
            Email <a className="font-semibold text-ink underline" href="mailto:info@dakyx.com">info@dakyx.com</a> and somebody will help.
          </p>
        )}
        <p className="mt-4 text-xs text-muted">In the editor, More → Guided tours shows you around on your own page.</p>
      </div>
    </div>
  );
}
