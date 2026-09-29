import { integerSetting } from "../lib/capacity.js";

/** The forecast is supplied by operations; this is not a substitute for Railway billing. */
export function costControlState() {
  const forecast = Number(process.env.RAILWAY_PROJECTED_MONTHLY_USD ?? 0);
  if (!Number.isFinite(forecast) || forecast < 0) throw new Error("Invalid RAILWAY_PROJECTED_MONTHLY_USD");
  return { forecastUsd: forecast, source: "operator" as const,
    warning: forecast >= 45 ? "critical" : forecast >= 40 ? "high" : forecast >= 30 ? "watch" : "normal",
    pauseBulk: forecast >= 45, pauseRefresh: forecast >= 40 };
}

export function startCostAlerts() {
  const emit = () => {
    const state = costControlState();
    if (state.warning !== "normal") console.warn(JSON.stringify({ event: "hosting_budget", ...state }));
  };
  emit();
  const timer = setInterval(emit, integerSetting("COST_ALERT_INTERVAL_SECONDS", 300, 60, 3600) * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
costControlState(); // Invalid deployment forecasts must not silently disable budget protection.
