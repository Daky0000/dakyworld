import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth, type CurrentUser } from "../lib/auth";
import { Card } from "./ui";

export function isAdminUser(user: CurrentUser | null, can: (permission: string) => boolean): boolean {
  if (!user) return false;
  if (
    user.role === "OWNER" ||
    user.roleName === "Owner" ||
    user.roleName?.toLowerCase().includes("owner") ||
    user.roleName?.toLowerCase().includes("admin")
  ) {
    return true;
  }
  return can("team.access") || can("settings.view");
}

export function AdminGuard({ children }: { children: ReactNode }) {
  const { user, can } = useAuth();
  if (isAdminUser(user, can)) return <>{children}</>;

  return (
    <Card className="mx-auto max-w-lg p-8 text-center mt-12">
      <div className="inline-flex items-center gap-1.5 rounded-full bg-danger-surface px-3 py-1 font-sans text-[11px] font-semibold uppercase tracking-[.06em] text-danger-text">
        Admin Restricted
      </div>
      <h1 className="mt-4 font-display text-[22px] font-medium tracking-[-.03em]">Administrator Access Only</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        {user?.roleName ? (
          <>
            Your current role is <span className="font-semibold text-ink">{user.roleName}</span>. The Africon Leads
            intelligence module and template-driven imports are reserved for administrators and system owners.
          </>
        ) : (
          <>This section is strictly restricted to administrators and system owners.</>
        )}
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex rounded-full bg-ink px-5 py-2.5 text-[12px] font-semibold text-white transition hover:bg-ink/85"
      >
        Back to Dashboard
      </Link>
    </Card>
  );
}
