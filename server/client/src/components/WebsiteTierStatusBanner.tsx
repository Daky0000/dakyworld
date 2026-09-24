import { useCallback, useEffect, useState } from "react";
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
      setStatus(data);
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

export function WebsiteTierStatusBanner({
  siteId,
  compact = false,
  onUserSwitched,
}: {
  siteId?: string;
  compact?: boolean;
  onUserSwitched?: () => void;
}) {
  const { status, loading, simulateMonths, switchTestUser, toggleSimulateMonths } = useWebsiteTierStatus(siteId);
  const [expanded, setExpanded] = useState(false);

  if (!status) return null;

  const badgeColors: Record<string, { bg: string; border: string; text: string }> = {
    EDITOR: { bg: "rgba(56, 189, 248, 0.12)", border: "rgba(56, 189, 248, 0.35)", text: "#38BDF8" },
    CARE: { bg: "rgba(184, 255, 61, 0.12)", border: "rgba(184, 255, 61, 0.4)", text: "#B8FF3D" },
    MANAGED: { bg: "rgba(192, 132, 252, 0.14)", border: "rgba(192, 132, 252, 0.45)", text: "#C084FC" },
  };
  const theme = badgeColors[status.planCode] ?? badgeColors.EDITOR;

  const storageColor =
    status.storage.percentUsed >= 90
      ? "#F87171"
      : status.storage.percentUsed >= 70
        ? "#FBBF24"
        : theme.text;

  return (
    <div
      style={{
        background: "rgba(8, 16, 31, 0.88)",
        border: `1px solid ${theme.border}`,
        borderRadius: 8,
        padding: compact ? "8px 12px" : "10px 14px",
        marginBottom: compact ? 10 : 14,
        color: "#F4F5F0",
        fontSize: "0.78rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {/* Left: Tier badge + Pricing + Active User */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span
            style={{
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              color: theme.text,
              fontWeight: 700,
              padding: "3px 8px",
              borderRadius: 4,
              fontSize: "0.72rem",
              letterSpacing: "0.04em",
            }}
          >
            {status.tierName} • {status.pricing.priceDisplay}/mo
          </span>

          <span
            style={{
              background: status.pricing.revertedToStandard
                ? "rgba(251, 191, 36, 0.14)"
                : "rgba(52, 211, 153, 0.14)",
              border: `1px solid ${
                status.pricing.revertedToStandard ? "rgba(251, 191, 36, 0.4)" : "rgba(52, 211, 153, 0.35)"
              }`,
              color: status.pricing.revertedToStandard ? "#FBBF24" : "#34D399",
              padding: "2px 7px",
              borderRadius: 4,
              fontSize: "0.7rem",
              fontWeight: 600,
            }}
          >
            {status.pricing.revertedToStandard
              ? `Month 4+ Standard Rate: $${status.pricing.effectiveMonthlyPrice}/mo`
              : `Months 1–3 Promo: $${status.pricing.effectiveMonthlyPrice}/mo (reverts to $${status.pricing.standardMonthlyPrice}/mo after 3 mos)`}
          </span>

          <span style={{ color: "rgba(244,245,240,0.72)", fontSize: "0.73rem" }}>
            Subscriber: <strong style={{ color: "#F4F5F0" }}>{status.userName}</strong>{" "}
            <span style={{ fontFamily: "monospace", color: "rgba(244,245,240,0.55)" }}>({status.userEmail})</span>
          </span>
        </div>

        {/* Right: Storage Bar + Usage Counters + Switcher Toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          {/* Storage quota mini bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 7 }} title="Per-user Media Library storage quota">
            <span style={{ color: "rgba(244,245,240,0.65)", fontSize: "0.72rem" }}>Storage:</span>
            <div
              style={{
                width: 74,
                height: 7,
                background: "rgba(255,255,255,0.1)",
                borderRadius: 999,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.max(3, status.storage.percentUsed)}%`,
                  height: "100%",
                  background: storageColor,
                }}
              />
            </div>
            <span style={{ fontFamily: "monospace", fontSize: "0.72rem", color: "#F4F5F0" }}>
              {status.storage.usedFormatted} / {status.storage.quotaFormatted}
            </span>
          </div>

          {/* Monthly usage */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "0.72rem", color: "rgba(244,245,240,0.75)" }}>
            <span>
              Imports:{" "}
              <strong style={{ color: "#F4F5F0" }}>
                {status.usage.importsUsed}/{status.usage.importsLimit ?? "∞"}
              </strong>
            </span>
            <span>
              Edits:{" "}
              <strong style={{ color: "#F4F5F0" }}>
                {status.usage.editsUsed}/{status.usage.editsLimit ?? "∞"}
              </strong>
            </span>
          </div>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: expanded ? theme.bg : "rgba(255,255,255,0.06)",
              border: `1px solid ${expanded ? theme.border : "rgba(255,255,255,0.16)"}`,
              color: expanded ? theme.text : "#F4F5F0",
              borderRadius: 5,
              padding: "4px 9px",
              fontSize: "0.71rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {expanded ? "Hide Tier & User Switcher ▲" : "Switch Test User / Tier Plan ▼"}
          </button>
        </div>
      </div>

      {/* Expandable Test User Switcher, 3-Month Price Reversion Simulator & Tier Comparison */}
      {expanded && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid rgba(255,255,255,0.1)",
            display: "grid",
            gap: 12,
          }}
        >
          {/* Row 1: Subscribed Test Users + 3-Month Reversion Toggle */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              background: "rgba(255,255,255,0.03)",
              padding: "10px 12px",
              borderRadius: 6,
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: "0.74rem", color: "#B8FF3D" }}>
                Subscribed Test Users (1-Click Switch):
              </span>
              {status.testUsers.map((u) => {
                const isCurrent = status.userEmail.toLowerCase() === u.email.toLowerCase();
                return (
                  <button
                    key={u.email}
                    type="button"
                    disabled={loading}
                    onClick={async () => {
                      await switchTestUser(u.email);
                      onUserSwitched?.();
                    }}
                    style={{
                      background: isCurrent ? "rgba(184, 255, 61, 0.18)" : "rgba(255,255,255,0.05)",
                      border: `1px solid ${isCurrent ? "#B8FF3D" : "rgba(255,255,255,0.16)"}`,
                      color: isCurrent ? "#B8FF3D" : "#F4F5F0",
                      borderRadius: 5,
                      padding: "5px 10px",
                      fontSize: "0.72rem",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <strong>{u.tierLabel}</strong> ({u.priceDisplay}) — {u.email}
                    <span style={{ display: "block", fontSize: "0.66rem", opacity: 0.72 }}>
                      Pwd: {u.password} • Storage: {u.storageLabel}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 3-Month Promo -> Standard Price Reversion Simulator */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: "0.72rem", color: "rgba(244,245,240,0.75)" }}>Billing Period Test:</span>
              <button
                type="button"
                onClick={() => void toggleSimulateMonths(0)}
                style={{
                  background: simulateMonths < 3 ? "rgba(52, 211, 153, 0.18)" : "rgba(255,255,255,0.05)",
                  border: `1px solid ${simulateMonths < 3 ? "#34D399" : "rgba(255,255,255,0.15)"}`,
                  color: simulateMonths < 3 ? "#34D399" : "#F4F5F0",
                  borderRadius: 4,
                  padding: "4px 8px",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Months 1–3 Promo ($3 / $10 / $25)
              </button>
              <button
                type="button"
                onClick={() => void toggleSimulateMonths(4)}
                style={{
                  background: simulateMonths >= 3 ? "rgba(251, 191, 36, 0.2)" : "rgba(255,255,255,0.05)",
                  border: `1px solid ${simulateMonths >= 3 ? "#FBBF24" : "rgba(255,255,255,0.15)"}`,
                  color: simulateMonths >= 3 ? "#FBBF24" : "#F4F5F0",
                  borderRadius: 4,
                  padding: "4px 8px",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Month 4+ Standard Reversion ($5 / $16 / $45)
              </button>
            </div>
          </div>

          {/* Row 2: 3-Tier Plan Feature & Quota Cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
              gap: 10,
            }}
          >
            {status.availableTiers.map((tier) => {
              const active = tier.planCode === status.planCode;
              return (
                <div
                  key={tier.planCode}
                  style={{
                    background: active ? "rgba(184, 255, 61, 0.06)" : "rgba(255,255,255,0.02)",
                    border: `1px solid ${active ? "#B8FF3D" : "rgba(255,255,255,0.1)"}`,
                    borderRadius: 6,
                    padding: "10px 12px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                    <strong style={{ fontSize: "0.8rem", color: active ? "#B8FF3D" : "#F4F5F0" }}>
                      {tier.tierName} ({tier.tierBadge})
                    </strong>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "0.82rem", color: "#B8FF3D" }}>
                      {tier.priceDisplay}/mo
                    </span>
                  </div>
                  <div style={{ fontSize: "0.68rem", color: "rgba(244,245,240,0.6)", marginBottom: 6 }}>
                    ${tier.promoMonthlyPrice}/mo first {tier.promoMonths} months, then reverts to ${tier.standardMonthlyPrice}/mo standard
                  </div>
                  <div style={{ fontSize: "0.71rem", color: "#F4F5F0", marginBottom: 6 }}>
                    • Media Storage: <strong>{tier.storageLabel}</strong> • Imports:{" "}
                    <strong>{tier.limits.monthlyImports ?? "Unlimited"}/mo</strong> • Edits:{" "}
                    <strong>{tier.limits.monthlyEdits ?? "Unlimited"}/mo</strong>
                  </div>
                  <div style={{ fontSize: "0.68rem", color: "#34D399" }}>
                    ✓ {tier.featureSummary.slice(0, 4).join(" • ")}
                  </div>
                  {tier.lockedFeatures.length > 0 && (
                    <div style={{ fontSize: "0.67rem", color: "#F87171", marginTop: 4 }}>
                      🔒 Locked: {tier.lockedFeatures.join(", ")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
