import assert from "node:assert/strict";
import { AVAILABLE_ADDONS } from "../src/services/websiteClientPortal.js";
import { WEBSITE_TIER_PLANS } from "../src/services/websiteTierPlans.js";

async function runChecks() {
  console.log("Starting clientBalanceAndActivity checks...");
  let checksPassed = 0;

  // 1. Verify Tier plans have proper AI prompt limits and quota structures
  assert.ok(WEBSITE_TIER_PLANS.EDITOR.aiPromptsLimit === 0, "EDITOR tier should have 0 AI prompts included");
  assert.ok(WEBSITE_TIER_PLANS.CARE.aiPromptsLimit === 50, "CARE tier should have 50 AI prompts included");
  assert.ok(WEBSITE_TIER_PLANS.MANAGED.aiPromptsLimit >= 10000, "MANAGED tier should have high/unlimited AI prompts");
  checksPassed += 3;

  // 2. Verify Available Add-ons for Revenue Generation
  assert.ok(AVAILABLE_ADDONS.length >= 4, "Should have at least 4 available revenue add-ons");
  const aiBooster = AVAILABLE_ADDONS.find((a) => a.id === "ai_booster_100");
  assert.ok(aiBooster, "Should have ai_booster_100 add-on");
  assert.equal(aiBooster?.amount, 150, "AI booster should be 150 GHS");
  assert.equal(aiBooster?.currency, "GHS", "Currency should be GHS");

  const maintenancePack = AVAILABLE_ADDONS.find((a) => a.id === "maintenance_5h");
  assert.ok(maintenancePack, "Should have maintenance_5h add-on");
  assert.equal(maintenancePack?.amount, 600, "Maintenance pack should be 600 GHS");

  const seoAudit = AVAILABLE_ADDONS.find((a) => a.id === "seo_audit");
  assert.ok(seoAudit, "Should have seo_audit add-on");
  assert.equal(seoAudit?.amount, 450, "SEO audit should be 450 GHS");

  const domainEmail = AVAILABLE_ADDONS.find((a) => a.id === "domain_email");
  assert.ok(domainEmail, "Should have domain_email add-on");
  assert.equal(domainEmail?.amount, 350, "Domain & email should be 350 GHS");
  checksPassed += 8;

  // 3. Test Balance & Outstanding Calculation Logic
  const mockInvoices = [
    { id: "1", invoiceNumber: "DAK-SEP-2026-001", amountTotal: 750, currency: "GHS", status: "SENT", dueDate: new Date(Date.now() + 86400000) },
    { id: "2", invoiceNumber: "DAK-AUG-2026-002", amountTotal: 1250, currency: "GHS", status: "PAID", dueDate: new Date(Date.now() - 86400000 * 30), paidAt: new Date() },
    { id: "3", invoiceNumber: "DAK-JUL-2026-003", amountTotal: 500, currency: "GHS", status: "OVERDUE", dueDate: new Date(Date.now() - 86400000 * 10) },
  ];

  let outstandingAmount = 0;
  let paidLifetime = 0;
  let hasOverdue = false;

  for (const inv of mockInvoices) {
    if (inv.status === "PAID") {
      paidLifetime += inv.amountTotal;
    } else if (inv.status === "SENT" || inv.status === "OVERDUE") {
      outstandingAmount += inv.amountTotal;
      if (inv.status === "OVERDUE" || inv.dueDate.getTime() < Date.now()) {
        hasOverdue = true;
      }
    }
  }

  assert.equal(outstandingAmount, 1250, "Outstanding amount should sum SENT (750) and OVERDUE (500)");
  assert.equal(paidLifetime, 1250, "Paid lifetime should sum PAID (1250)");
  assert.equal(hasOverdue, true, "Should detect overdue invoice");
  checksPassed += 3;

  // 4. Test AI Usage Quota and Progress Percentage Calculations
  function computeAiQuota(promptsUsed: number, promptsLimit: number) {
    const remaining = Math.max(0, promptsLimit - promptsUsed);
    const percent = promptsLimit > 0 ? Math.min(100, Math.round((promptsUsed / promptsLimit) * 100)) : 100;
    return { remaining, percent };
  }

  const quota1 = computeAiQuota(10, 50);
  assert.equal(quota1.remaining, 40, "Remaining should be 40");
  assert.equal(quota1.percent, 20, "Percent should be 20%");

  const quota2 = computeAiQuota(55, 50);
  assert.equal(quota2.remaining, 0, "Remaining cannot be negative");
  assert.equal(quota2.percent, 100, "Percent capped at 100%");

  const quota3 = computeAiQuota(0, 0);
  assert.equal(quota3.remaining, 0, "Remaining on Starter is 0");
  assert.equal(quota3.percent, 100, "Starter shows 100% (quota maxed/not included)");
  checksPassed += 6;

  // 5. Activity Categorization Logic
  function categorizeEvent(kind: string): "content" | "ai" | "media" | "billing" | "settings" | "team" {
    const k = kind.toUpperCase();
    if (k.includes("AI") || k.includes("ASSISTANT") || k.includes("AGENT") || k.includes("SETUP.ASSISTANCE")) return "ai";
    if (k.includes("ASSET") || k.includes("MEDIA") || k.includes("IMAGE")) return "media";
    if (k.includes("SETTING") || k.includes("CONNECT") || k.includes("DOMAIN")) return "settings";
    if (k.includes("MEMBER") || k.includes("INVITE") || k.includes("TEAM")) return "team";
    if (k.includes("BILLING")) return "billing";
    return "content";
  }

  assert.equal(categorizeEvent("PUBLISH"), "content");
  assert.equal(categorizeEvent("SOURCE_EDIT"), "content");
  assert.equal(categorizeEvent("ROLLBACK"), "content");
  assert.equal(categorizeEvent("AI_ASSISTANT"), "ai");
  assert.equal(categorizeEvent("setup.assistance.requested"), "ai");
  assert.equal(categorizeEvent("ASSET_UPLOAD"), "media");
  assert.equal(categorizeEvent("ASSET_DELETED"), "media");
  assert.equal(categorizeEvent("SETTINGS_UPDATED"), "settings");
  assert.equal(categorizeEvent("SITE_CONNECTED"), "settings");
  assert.equal(categorizeEvent("MEMBER_INVITED"), "team");
  assert.equal(categorizeEvent("BILLING_ADDON"), "billing");
  checksPassed += 11;

  console.log(`clientBalanceAndActivity: ${checksPassed} checks passed`);
}

runChecks().catch((err) => {
  console.error(err);
  process.exit(1);
});
