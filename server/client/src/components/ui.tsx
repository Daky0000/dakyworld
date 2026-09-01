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
    // Wraps rather than overflows. `items-end` on a row that cannot fit its
    // action pushed the button off the right edge on a narrow window, which is
    // where the one thing you came to the page to do usually lives.
    <div className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-3">{<Eyebrow>{eyebrow}</Eyebrow>}</div>}
        <h1 className="font-display text-3xl tracking-[-.03em]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * A heading for a block inside a page — the level below `PageHeader`.
 *
 * Written by hand on every screen before this, which is why the same rank of
 * heading appears as `text-xl`, `text-lg` and `text-[22px]` in three places,
 * sometimes with a "Manage →" link beside it and sometimes not.
 */
export function SectionHeading({
  title,
  hint,
  action,
  className = "",
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 ${className}`}>
      <div className="min-w-0">
        <h2 className="font-display text-xl tracking-[-.03em]">{title}</h2>
        {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * §24. White, one hairline, 16px corners.
 *
 * `flush` drops the padding for the case a card exists only to hold a table —
 * a table inside 24px of padding inside a border reads as a box in a box, and
 * the row rules stop short of the card edge for no reason.
 */
export function Card({
  children,
  className = "",
  flush,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-line bg-white ${flush ? "" : "p-6"} ${className}`}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "positive" | "muted" | "warn" | "danger" | "info";
}) {
  // Lime is action and positive status only, so a caveat badge must never
  // reach for it — warn is ochre, danger is the cool red, and both come from
  // the status families in tailwind.config.js rather than from Tailwind stock.
  const toneClass = {
    default: "text-ink bg-ink/10",
    positive: "text-positive-text bg-positive-surface",
    warn: "text-warn-text bg-warn-surface",
    danger: "text-danger-text bg-danger-surface",
    info: "text-info-text bg-info-surface",
    muted: "text-muted bg-sunken",
  }[tone];
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
    primary: "bg-ink text-white hover:-translate-y-px hover:shadow-lift",
    accent: "bg-lime text-ink hover:-translate-y-px hover:shadow-accent",
    secondary: "border border-line text-ink hover:border-ink/40 hover:bg-sunken",
    ghost: "text-muted hover:text-ink",
    // Quiet until pointed at, then unmistakable. A red-outlined pill sitting
    // permanently among ink and lime ones read as a fifth brand colour; a
    // destructive action does not need to shout while nobody is touching it.
    danger: "border border-danger-line text-danger-text hover:border-transparent hover:bg-danger hover:text-white",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${sizing} ${styles} ${className}`}>
      {children}
    </button>
  );
}

// --- Tables ----------------------------------------------------------------

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-white">
      <table className="w-full min-w-[640px] text-left text-sm">{children}</table>
    </div>
  );
}

/**
 * The header row, once.
 *
 * There were five spellings of this row across the eighteen tables in the
 * product — two border colours, two text colours, `font-mono` on some and not
 * others — and thirteen spellings of the cell padding underneath it. None of
 * that was a decision; it was whichever nearby table got copied.
 */
export function Thead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-muted">{children}</tr>
    </thead>
  );
}

export function Th({
  children,
  align = "left",
  className = "",
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  const alignment = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return <th className={`px-4 py-3 font-normal ${alignment} ${className}`}>{children}</th>;
}

export function Td({
  children,
  align = "left",
  className = "",
  colSpan,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  const alignment = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <td colSpan={colSpan} className={`px-4 py-3 align-middle ${alignment} ${className}`}>
      {children}
    </td>
  );
}

export function Tr({
  children,
  onClick,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={`border-b border-line last:border-0 ${onClick ? "cursor-pointer transition hover:bg-sunken" : ""} ${className}`}
    >
      {children}
    </tr>
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

// --- States ----------------------------------------------------------------

export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-white/40 p-10 text-center text-sm text-muted">
      <p>{message}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * "Loading…" was written out as bare grey text thirty-three times, in four
 * different sizes and three different greys, and on the wider screens it was a
 * single line of 12px type in the top-left of an otherwise empty page.
 *
 * `rows` draws the shape of what is coming instead, which is the difference
 * between a page that is working and a page that looks broken.
 */
export function Loading({ label = "Loading", rows = 0 }: { label?: string; rows?: number }) {
  if (rows > 0) {
    return (
      <div className="space-y-2" role="status" aria-label={label}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-11 animate-pulse rounded-xl bg-sunken" style={{ animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 text-sm text-muted" role="status">
      <span className="h-2 w-2 animate-pulse rounded-full bg-blue" aria-hidden />
      {label}…
    </div>
  );
}

/**
 * The one way this product says something went wrong, or nearly did.
 *
 * Before this there were about five hundred hand-written alert boxes drawing on
 * twelve steps of Tailwind's amber, ten of its red and eight of its emerald —
 * so the same warning could be `amber-200` on one screen and `amber-300` on the
 * next, and none of the three families were Dakyworld colours at all.
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  className = "",
}: {
  tone?: "info" | "warn" | "danger" | "positive";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const toneClass = {
    info: "border-info-line bg-info-surface text-info-text",
    warn: "border-warn-line bg-warn-surface text-warn-text",
    danger: "border-danger-line bg-danger-surface text-danger-text",
    positive: "border-positive-line bg-positive-surface text-positive-text",
  }[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-xl border px-3.5 py-2.5 text-sm ${toneClass} ${className}`}
    >
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
      </div>
      {action}
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
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
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
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-blue" : "bg-line-strong"}`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[1.15rem]" : "left-0.5"}`}
        />
      </span>
      <span className={`text-[11px] font-bold uppercase tracking-[.1em] ${checked ? "text-ink" : "text-muted"}`}>{label}</span>
    </button>
  );
}

// --- Readouts --------------------------------------------------------------

/**
 * The frame a row of numbers sits in.
 *
 * The dashboard drew its four headline figures as a seam grid — one hairline
 * box, cells divided by a 1px gutter — and everything else in the product drew
 * the same rank of number as separate bordered tiles. Both are defensible; two
 * of them in one product, on the same screen, is not. The seam grid won: it
 * reads as one instrument rather than four unrelated cards, and §58 asks for
 * separation by rule rather than by box.
 */
export function StatGrid({ children, columns = 4 }: { children: ReactNode; columns?: 3 | 4 | 5 }) {
  const cols = { 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4", 5: "sm:grid-cols-3 lg:grid-cols-5" }[columns];
  return <div className={`grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-line bg-line ${cols}`}>{children}</div>;
}

export function StatTile({
  label,
  value,
  sub,
  standalone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** Outside a `StatGrid` the tile has to carry its own border and corners. */
  standalone?: boolean;
}) {
  return (
    <div className={`bg-white px-5 py-4 ${standalone ? "rounded-2xl border border-line" : ""}`}>
      <div className="micro">{label}</div>
      <div className="mt-2 font-display text-2xl leading-none tracking-[-.04em]">{value}</div>
      {sub && <div className="mt-1.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Lead score as a bar — scanning 200 scraped rows by number alone is hopeless. */
export function ScoreBar({ score }: { score: number }) {
  // Blue rather than grey in the middle band. Grey is what this UI uses for
  // "off" and "not applicable", so a score of 51 rendered in it read as a lead
  // with no score rather than an average one.
  const tone = score >= 70 ? "bg-lime" : score >= 45 ? "bg-blue" : "bg-line-strong";
  return (
    <span className="flex items-center gap-2" title={`Lead score ${score}/100`}>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-sunken">
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
  if (!value) return <span className="text-faint">—</span>;
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
            className="shrink-0 rounded-full border border-line px-3 py-1 text-[11px] font-bold text-muted transition hover:border-ink/40 hover:text-ink"
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

/**
 * A centred panel, for the things a side drawer is the wrong shape for.
 *
 * `Drawer` is right for one record — a lead, a run — because it is tall and
 * narrow and the page behind it stays legible. A table is neither: a list of
 * leads with its own columns needs the width, and reading it in a 36rem column
 * is the reason lists were rendered inline down the page in the first place.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = "wide",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "wide" | "full";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        className={`relative flex w-full flex-col overflow-hidden rounded-2xl border border-ink/10 bg-cream shadow-2xl ${
          size === "full" ? "max-w-[92rem]" : "max-w-6xl"
        }`}
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
            aria-label="Close"
            className="shrink-0 rounded-full border border-line px-3 py-1 text-[11px] font-bold text-muted transition hover:border-ink/40 hover:text-ink"
          >
            Close
          </button>
        </header>
        {/* Capped rather than full-height: a modal as tall as the window with a
            short table in it reads as a broken page. */}
        <div className="max-h-[70vh] flex-1 overflow-auto px-6 py-5">{children}</div>
        {footer && <footer className="border-t border-line bg-white px-6 py-4">{footer}</footer>}
      </div>
    </div>
  );
}

/** Status pill shared by leads, runs and sources. */
export function StatusDot({ tone }: { tone: "live" | "ok" | "warn" | "bad" | "idle" }) {
  const colour = {
    live: "bg-lime animate-pulse",
    ok: "bg-positive",
    warn: "bg-warn",
    bad: "bg-danger",
    idle: "bg-line-strong",
  }[tone];
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${colour}`} aria-hidden />;
}
