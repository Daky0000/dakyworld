import type { ReactNode } from "react";

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
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary";
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const base = "inline-flex items-center gap-2 px-4 py-2 font-mono text-xs uppercase tracking-[.12em] transition disabled:opacity-50";
  const styles = variant === "primary" ? "bg-ink text-ivory hover:bg-black" : "border border-ink/20 text-ink hover:border-ink";
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
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

export function EmptyState({ message }: { message: string }) {
  return <div className="border border-dashed border-ink/20 p-10 text-center text-sm text-ink/50">{message}</div>;
}
