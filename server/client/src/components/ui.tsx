import { useEffect, type ReactNode } from "react";

/**
 * The house eyebrow — a short lime dash followed by a tracked micro-label.
 * The one piece of the marketing site's language that belongs on every
 * Dakyworld surface, including this one.
 */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[.15em] text-muted">
      <span className="h-[3px] w-[22px] shrink-0 rounded-full bg-lime" aria-hidden />
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  action,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex items-end justify-between gap-6">
      <div>
        {eyebrow && <div className="mb-3">{<Eyebrow>{eyebrow}</Eyebrow>}</div>}
        <h1 className="font-display text-3xl tracking-[-.03em]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-white p-6 ${className}`}>{children}</div>;
}

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "positive" | "muted" | "warn" }) {
  // Amber carries the warning state everywhere in this UI; lime is action and
  // positive status only, so a caveat badge must never reach for it.
  const toneClass =
    tone === "positive"
      ? "text-ink bg-lime/30"
      : tone === "warn"
        ? "text-amber-900 bg-amber-100"
        : tone === "muted"
          ? "text-ink/50 bg-ink/5"
          : "text-ink bg-ink/10";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[.1em] ${toneClass}`}
    >
      {children}
    </span>
  );
}

/**
 * The dark circular arrow that rides inside an accent button (design system
 * §19). Exported so a page can put one on a link that is not a Button.
 */
export function Pip({ children = "↗" }: { children?: ReactNode }) {
  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink text-[11px] leading-none text-lime transition-transform group-hover:translate-x-px group-hover:-translate-y-px"
      aria-hidden
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  type = "button",
  disabled,
  size = "md",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  /**
   * `accent` is the lime pill. It is the loudest thing on a screen, so a screen
   * gets at most one — the system keeps lime at a few percent of the surface
   * precisely so it still means something. Everything else is `primary`.
   */
  variant?: "primary" | "accent" | "secondary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  size?: "sm" | "md";
  title?: string;
  className?: string;
}) {
  const base =
    "group inline-flex items-center gap-2 rounded-full font-semibold transition disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue";
  const sizing = size === "sm" ? "px-3 py-1.5 text-[11px]" : "px-4 py-2 text-[13px]";
  const styles = {
    primary: "bg-ink text-white hover:-translate-y-px hover:shadow-[0_10px_24px_rgba(8,16,31,.18)]",
    accent: "bg-lime text-ink hover:-translate-y-px hover:shadow-[0_10px_28px_rgba(184,255,61,.32)]",
    secondary: "border border-line text-ink hover:border-ink/40 hover:bg-ink/[.03]",
    ghost: "text-muted hover:text-ink",
    danger: "border border-red-300 text-red-700 hover:border-red-500 hover:bg-red-50",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${sizing} ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-white">
      <table className="w-full min-w-[640px] text-left text-sm">{children}</table>
    </div>
  );
}

export function Money({ amount, currency = "GHS" }: { amount: number | string; currency?: string }) {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return (
    <span>
      {currency} {n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}

export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-ink/20 p-10 text-center text-sm text-muted">
      <p>{message}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// --- Forms -----------------------------------------------------------------

export function Field({
  label,
  hint,
  children,
  full,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`block text-sm ${full ? "sm:col-span-2" : ""}`}>
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[.1em] text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink/40">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-3 text-left"
      aria-pressed={checked}
    >
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-blue" : "bg-ink/20"}`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[1.15rem]" : "left-0.5"}`}
        />
      </span>
      <span className="text-[11px] font-bold uppercase tracking-[.1em] text-muted">{label}</span>
    </button>
  );
}

// --- Readouts --------------------------------------------------------------

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-white px-4 py-3.5">
      <div className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">{label}</div>
      <div className="mt-1.5 font-display text-2xl leading-none tracking-[-.04em]">{value}</div>
      {sub && <div className="mt-1.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Lead score as a bar — scanning 200 scraped rows by number alone is hopeless. */
export function ScoreBar({ score }: { score: number }) {
  const tone = score >= 70 ? "bg-lime" : score >= 45 ? "bg-ink/50" : "bg-ink/20";
  return (
    <span className="flex items-center gap-2" title={`Lead score ${score}/100`}>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-ink/10">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(4, score)}%` }} />
      </span>
      <span className="font-mono text-[11px] text-muted">{score}</span>
    </span>
  );
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60_000],
  ["minute", 60 * 60_000],
  ["hour", 24 * 60 * 60_000],
  ["day", 7 * 24 * 60 * 60_000],
];

/** "in 6 hours" / "3 days ago" — the only readable way to show a schedule. */
export function RelativeTime({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-ink/40">—</span>;
  const date = new Date(value);
  const diff = date.getTime() - Date.now();
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  let text: string;
  const absolute = Math.abs(diff);
  if (absolute < 60_000) text = format.format(Math.round(diff / 1000), "second");
  else if (absolute < 60 * 60_000) text = format.format(Math.round(diff / 60_000), "minute");
  else if (absolute < 24 * 60 * 60_000) text = format.format(Math.round(diff / (60 * 60_000)), "hour");
  else if (absolute < 30 * 24 * 60 * 60_000) text = format.format(Math.round(diff / (24 * 60 * 60_000)), "day");
  else text = date.toLocaleDateString();

  return <span title={date.toLocaleString()}>{text}</span>;
}

// --- Overlay ---------------------------------------------------------------

/** Right-hand slide-over used for lead detail and the source editor. */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    // Stop the page behind from scrolling under the panel.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <aside
        className={`relative flex h-full w-full flex-col border-l border-ink/10 bg-cream shadow-2xl ${wide ? "max-w-3xl" : "max-w-xl"}`}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line bg-white px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate font-display text-xl tracking-[-.03em]">{title}</h2>
            {subtitle && <div className="mt-0.5 text-xs text-muted">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line px-3 py-1 text-[11px] font-bold text-muted transition hover:border-ink/40 hover:text-ink"
          >
            Close
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="border-t border-line bg-white px-6 py-4">{footer}</footer>}
      </aside>
    </div>
  );
}

/** Status pill shared by leads, runs and sources. */
export function StatusDot({ tone }: { tone: "live" | "ok" | "warn" | "bad" | "idle" }) {
  const colour = {
    live: "bg-lime animate-pulse",
    ok: "bg-emerald-500",
    warn: "bg-amber-500",
    bad: "bg-red-500",
    idle: "bg-ink/20",
  }[tone];
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${colour}`} aria-hidden />;
}
