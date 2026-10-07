import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

export interface WebsiteTierFeatures {
  visualEditor: boolean;
  mediaLibrary: boolean;
  autoCaptureImportedImages: boolean;
  customElementInsertion: boolean;
  themeSettings: boolean;
  seoInspector: boolean;
  aiAssistant: boolean;
  aiBuilderAgent: boolean;
  sourceCodeEditor: boolean;
  pullRequestPublish: boolean;
}

export interface WebsiteTierStatus {
  userId: string;
  userEmail: string;
  userName: string;
  planCode: "EDITOR" | "CARE" | "MANAGED";
  tierName: string;
  tierBadge: string;
  tagline: string;
  pricing: {
    promoMonthlyPrice: number;
    standardMonthlyPrice: number;
    effectiveMonthlyPrice: number;
    priceDisplay: string;
    /** The currency this customer pays in, fixed at purchase. */
    currency?: "GHS" | "USD";
    /** "GHS 300" or "$25", formatted by the server in that currency. */
    promoDisplay?: string;
    standardDisplay?: string;
    currentDisplay?: string;
    activeBillingLabel: string;
    promoActive: boolean;
    revertedToStandard: boolean;
    subscribedAt: string;
    promoEndsAt: string;
    daysRemainingInPromo: number;
    monthsSubscribed: number;
  };
  storage: {
    usedBytes: number;
    quotaBytes: number;
    remainingBytes: number;
    percentUsed: number;
    maxSingleAssetBytes: number;
    assetCount: number;
    usedFormatted: string;
    quotaFormatted: string;
    remainingFormatted: string;
    maxSingleAssetFormatted: string;
  };
  usage: {
    monthKey: string;
    importsUsed: number;
    importsLimit: number | null;
    importsRemaining: number | null;
    editsUsed: number;
    editsLimit: number | null;
    editsRemaining: number | null;
    aiPromptsUsed: number;
    aiPromptsLimit: number | null;
    aiPromptsRemaining: number | null;
  };
  features: WebsiteTierFeatures;
  featureSummary: string[];
  lockedFeatures: string[];
  availableTiers: Array<{
    planCode: "EDITOR" | "CARE" | "MANAGED";
    tierName: string;
    tierBadge: string;
    priceDisplay: string;
    promoDisplay?: string;
    standardDisplay?: string;
    promoMonthlyPrice: number;
    standardMonthlyPrice: number;
    promoMonths: number;
    storageLabel: string;
    maxSingleAssetBytes: number;
    limits: {
      sites: number;
      users: number;
      monthlyImports: number | null;
      monthlyEdits: number | null;
      monthlyAiPrompts: number | null;
    };
    features: WebsiteTierFeatures;
    featureSummary: string[];
    lockedFeatures: string[];
  }>;
  /** Only ever filled on a local machine; the server seeds no test accounts anywhere deployed. */
  testUsers: Array<{
    email: string;
    password: string;
    name: string;
    planCode: "EDITOR" | "CARE" | "MANAGED";
    tierLabel: string;
    priceDisplay: string;
    promoMonthlyPrice: number;
    standardMonthlyPrice: number;
    storageLabel: string;
  }>;
}

const TIER_CHANGE_EVENT = "dw:tier-status-changed";

export function notifyTierStatusChanged() {
  window.dispatchEvent(new CustomEvent(TIER_CHANGE_EVENT));
}

export function useWebsiteTierStatus(siteId?: string) {
  const [status, setStatus] = useState<WebsiteTierStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [simulateMonths, setSimulateMonthsState] = useState<number>(() => {
    try {
      return Number(window.localStorage.getItem("dw:test-simulate-months") || "0") || 0;
    } catch {
      return 0;
    }
  });

  const refresh = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (siteId) qs.set("siteId", siteId);
      const sim = Number(window.localStorage.getItem("dw:test-simulate-months") || "0") || 0;
      if (sim > 0) qs.set("simulateMonths", String(sim));
      const query = qs.toString();
      const data = await api.get<WebsiteTierStatus>(`/website/tier-status${query ? `?${query}` : ""}`);
      if (data && typeof data === "object" && "features" in data && data.features && "planCode" in data) {
        setStatus(data);
      }
    } catch {
      // ignore non-critical fetch error
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void refresh();
    const handler = () => void refresh();
    window.addEventListener(TIER_CHANGE_EVENT, handler);
    return () => window.removeEventListener(TIER_CHANGE_EVENT, handler);
  }, [refresh]);

  const switchTestUser = useCallback(
    async (email: string | null, simMonths?: number) => {
      setLoading(true);
      try {
        if (email) {
          window.localStorage.setItem("dw:test-tier-user", email);
          const nextSim = simMonths !== undefined ? simMonths : simulateMonths;
          await api.post("/website/tier-status/switch-user", {
            email,
            simulateMonths: nextSim,
          });
        } else {
          window.localStorage.removeItem("dw:test-tier-user");
        }
        if (simMonths !== undefined) {
          setSimulateMonthsState(simMonths);
          if (simMonths > 0) {
            window.localStorage.setItem("dw:test-simulate-months", String(simMonths));
          } else {
            window.localStorage.removeItem("dw:test-simulate-months");
          }
        }
        notifyTierStatusChanged();
        await refresh();
      } finally {
        setLoading(false);
      }
    },
    [refresh, simulateMonths],
  );

  const toggleSimulateMonths = useCallback(
    async (months: number) => {
      setSimulateMonthsState(months);
      try {
        if (months > 0) {
          window.localStorage.setItem("dw:test-simulate-months", String(months));
        } else {
          window.localStorage.removeItem("dw:test-simulate-months");
        }
        const currentEmail = window.localStorage.getItem("dw:test-tier-user") || status?.userEmail;
        if (currentEmail && status?.testUsers.some((u) => u.email === currentEmail)) {
          await api.post("/website/tier-status/switch-user", {
            email: currentEmail,
            simulateMonths: months,
          });
        }
      } catch {
        // ignore
      }
      notifyTierStatusChanged();
      await refresh();
    },
    [refresh, status],
  );

  return {
    status,
    loading,
    simulateMonths,
    refresh,
    switchTestUser,
    toggleSimulateMonths,
  };
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * What the customer pays, in the currency they pay in.
 *
 * The first version printed the cedi amounts after a dollar sign — "GHS 300"
 * in one chip and "$300" in the next — because the dollar sign was typed into
 * the screen. The server now formats every figure in the customer's own
 * currency (cedis in Ghana, dollars elsewhere at the merchant rate), and this
 * only ever shows what it was given.
 */
export function planPriceSentence(pricing: WebsiteTierStatus["pricing"]): string {
  const current = pricing.currentDisplay ?? pricing.priceDisplay;
  if (pricing.revertedToStandard || !pricing.standardDisplay || pricing.standardDisplay === current) return `${current} a month`;
  return `${current} a month until ${dateFormat.format(new Date(pricing.promoEndsAt))}, then ${pricing.standardDisplay}`;
}

function usageLine(used: number, limit: number | null, noun: string): string {
  return limit === null ? `${used} ${noun} this month` : `${used} of ${limit} ${noun} this month`;
}

/** Storage and this month's usage — shared by the banner and the toolbar chip. */
function PlanUsage({ status }: { status: WebsiteTierStatus }) {
  const full = status.storage.percentUsed >= 90;
  const filling = status.storage.percentUsed >= 70;
  return (
    <div className="space-y-2 text-xs">
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted">Picture storage</span>
          <span className="font-semibold text-ink">{status.storage.usedFormatted} of {status.storage.quotaFormatted}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken" role="meter" aria-label="Picture storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(status.storage.percentUsed)}>
          <div className={`h-full rounded-full ${full ? "bg-danger" : filling ? "bg-warn" : "bg-blue"}`} style={{ width: `${Math.max(2, status.storage.percentUsed)}%` }} />
        </div>
      </div>
      <ul className="space-y-0.5 text-muted">
        <li>{usageLine(status.usage.editsUsed, status.usage.editsLimit, "edits")}</li>
        <li>{usageLine(status.usage.importsUsed, status.usage.importsLimit, "imports")}</li>
        {status.features.aiAssistant && <li>{usageLine(status.usage.aiPromptsUsed, status.usage.aiPromptsLimit, "AI requests")}</li>}
      </ul>
    </div>
  );
}

/**
 * The plan, as one chip in the editor's toolbar.
 *
 * It replaced a full-width banner that took ninety pixels off the page being
 * edited on every screen, printed the customer's own email back at them, and
 * offered paying customers a "Switch Test User / Tier Plan" control that only
 * ever worked on a developer's laptop.
 */
export function WebsitePlanChip({ siteId }: { siteId?: string }) {
  const { status } = useWebsiteTierStatus(siteId);
  if (!status) return null;
  const limited = status.usage.editsLimit !== null;
  const low = limited && (status.usage.editsRemaining ?? 0) <= Math.max(3, Math.round((status.usage.editsLimit ?? 0) * 0.1));
  return (
    <details className="relative" data-tour="plan-chip">
      <summary
        className={`flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold transition [&::-webkit-details-marker]:hidden ${
          low ? "border-warn-line bg-warn-surface text-warn-text" : "border-line bg-white text-ink hover:border-line-strong"
        }`}
        title="Your plan and what it includes"
      >
        <span>{status.tierName}</span>
        {limited && <span className="font-normal text-muted">· {status.usage.editsRemaining} edits left</span>}
      </summary>
      <div className="absolute right-0 top-10 z-[9990] w-72 rounded-2xl border border-line bg-white p-4 text-ink shadow-menu">
        <p className="font-display text-sm font-semibold">{status.tierName} plan</p>
        <p className="mt-0.5 text-xs text-muted">{planPriceSentence(status.pricing)}</p>
        <div className="mt-3">
          <PlanUsage status={status} />
        </div>
        <Link to="/website/balance" className="mt-3 inline-block text-xs font-semibold text-blue hover:underline">Plan, invoices and upgrades</Link>
      </div>
    </details>
  );
}

/**
 * The plan, as a row above a screen that spends from it — the media library,
 * importing a page, the pricing screen.
 */
export function WebsiteTierStatusBanner({
  siteId,
  compact = false,
  onUserSwitched,
}: {
  siteId?: string;
  compact?: boolean;
  onUserSwitched?: () => void;
}) {
  const { status, simulateMonths, switchTestUser, toggleSimulateMonths } = useWebsiteTierStatus(siteId);
  if (!status) return null;
  return (
    <section aria-label="Your plan" className={`rounded-2xl border border-line bg-white ${compact ? "mb-3 px-3 py-2.5" : "mb-4 px-4 py-3"}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{status.tierName} plan</p>
          <p className="text-xs text-muted">{planPriceSentence(status.pricing)}</p>
        </div>
        <div className="min-w-[14rem] flex-1 sm:max-w-sm">
          <PlanUsage status={status} />
        </div>
      </div>
      {status.testUsers.length > 0 && (
        <details className="mt-3 rounded-xl border border-dashed border-line-strong bg-sunken p-3 text-xs">
          <summary className="cursor-pointer font-semibold text-muted">Local test accounts (this only appears on a developer's machine)</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {status.testUsers.map((user) => (
              <button
                key={user.email}
                type="button"
                className={`rounded-lg border px-2.5 py-1.5 ${status.userEmail === user.email ? "border-blue bg-info-surface text-info-text" : "border-line bg-white text-ink hover:border-line-strong"}`}
                onClick={async () => { await switchTestUser(user.email); onUserSwitched?.(); }}
              >
                {user.tierLabel} — {user.email}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" className={`rounded-lg border px-2.5 py-1.5 ${simulateMonths < 3 ? "border-blue bg-info-surface" : "border-line bg-white"}`} onClick={() => void toggleSimulateMonths(0)}>Months 1–3</button>
            <button type="button" className={`rounded-lg border px-2.5 py-1.5 ${simulateMonths >= 3 ? "border-blue bg-info-surface" : "border-line bg-white"}`} onClick={() => void toggleSimulateMonths(4)}>Month 4 onwards</button>
          </div>
        </details>
      )}
    </section>
  );
}
