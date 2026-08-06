import { useEffect, type ReactNode } from "react";

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex items-end justify-between gap-6">
      <div>
        <h1 className="font-serif text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink/60">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`border border-ink/10 bg-white p-6 ${className}`}>{children}</div>;
}

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "gold" | "muted" }) {
  const toneClass =
    tone === "gold" ? "text-bronze bg-gold/15" : tone === "muted" ? "text-ink/50 bg-ink/5" : "text-ink bg-ink/10";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.1em] ${toneClass}`}>
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
  variant?: "primary" | "secondary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  size?: "sm" | "md";
  title?: string;
  className?: string;
}) {
  const base = "inline-flex items-center gap-2 font-mono uppercase tracking-[.12em] transition disabled:opacity-50";
  const sizing = size === "sm" ? "px-2.5 py-1 text-[10px]" : "px-4 py-2 text-xs";
  const styles = {
    primary: "bg-ink text-ivory hover:bg-black",
    secondary: "border border-ink/20 text-ink hover:border-ink",
    ghost: "text-ink/50 hover:text-ink",
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
    <div className="overflow-x-auto border border-ink/10 bg-white">
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
    <div className="border border-dashed border-ink/20 p-10 text-center text-sm text-ink/50">
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
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">{label}</span>
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
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-ink" : "bg-ink/20"}`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[1.15rem]" : "left-0.5"}`}
        />
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/60">{label}</span>
    </button>
  );
}

// --- Readouts --------------------------------------------------------------

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="border border-ink/10 bg-white px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">{label}</div>
      <div className="mt-1 font-serif text-2xl leading-none">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink/50">{sub}</div>}
    </div>
  );
}

/** Lead score as a bar — scanning 200 scraped rows by number alone is hopeless. */
export function ScoreBar({ score }: { score: number }) {
  const tone = score >= 70 ? "bg-gold" : score >= 45 ? "bg-ink/50" : "bg-ink/20";
  return (
    <span className="flex items-center gap-2" title={`Lead score ${score}/100`}>
      <span className="h-1.5 w-12 bg-ink/10">
        <span className={`block h-full ${tone}`} style={{ width: `${Math.max(4, score)}%` }} />
      </span>
      <span className="font-mono text-[11px] text-ink/60">{score}</span>
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
        className={`relative flex h-full w-full flex-col border-l border-ink/10 bg-ivory shadow-2xl ${wide ? "max-w-3xl" : "max-w-xl"}`}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-start justify-between gap-4 border-b border-ink/10 bg-white px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate font-serif text-xl">{title}</h2>
            {subtitle && <div className="mt-0.5 text-xs text-ink/50">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-xs uppercase tracking-[.14em] text-ink/40 transition hover:text-ink"
          >
            Close
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="border-t border-ink/10 bg-white px-6 py-4">{footer}</footer>}
      </aside>
    </div>
  );
}

/** Status pill shared by leads, runs and sources. */
export function StatusDot({ tone }: { tone: "live" | "ok" | "warn" | "bad" | "idle" }) {
  const colour = {
    live: "bg-gold animate-pulse",
    ok: "bg-emerald-500",
    warn: "bg-amber-500",
    bad: "bg-red-500",
    idle: "bg-ink/20",
  }[tone];
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${colour}`} aria-hidden />;
}
