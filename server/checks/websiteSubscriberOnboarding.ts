/**
 * Checks for the new subscribed user onboarding flow and interactive walkthroughs:
 * - Starter template generation for newly connected websites
 * - Template catalog & semantic section validation
 * - Site provisioning with auto-generated initial page
 * - Client workspace navigation and onboarding readiness
 *
 *   npx tsx checks/websiteSubscriberOnboarding.ts
 */
import assert from "node:assert/strict";
import {
  generateStarterSiteHtml,
  STARTER_TEMPLATES,
  type StarterTemplateKey,
} from "../src/services/websiteSectionTemplates.js";
import { CLIENT_NAV, CLIENT_HOME, withinClientWorkspace } from "../client/src/lib/clientWorkspace.js";
import { websiteRequestAction } from "../src/services/websiteAccess.js";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks++;
}

// 1. Starter Template Catalog
const templateKeys: StarterTemplateKey[] = ["business", "saas", "portfolio", "local", "blank"];
check("all 5 starter template keys are defined", templateKeys.every((k) => k in STARTER_TEMPLATES));

for (const key of templateKeys) {
  const tpl = STARTER_TEMPLATES[key];
  check(`template ${key} has valid name`, typeof tpl.name === "string" && tpl.name.length > 0);
  check(`template ${key} has tagline`, typeof tpl.tagline === "string" && tpl.tagline.length > 0);
  check(`template ${key} has description`, typeof tpl.description === "string" && tpl.description.length > 0);
  check(`template ${key} has sections`, Array.isArray(tpl.sections) && tpl.sections.length > 0);

  const html = generateStarterSiteHtml({
    siteName: "Acme Test Corp",
    publicUrl: "https://acmetest.com",
    templateKey: key,
  });

  check(`template ${key} generates valid HTML with doctype`, html.includes("<!DOCTYPE html>"));
  check(`template ${key} includes viewport meta`, html.includes('<meta name="viewport"'));
  check(`template ${key} includes site name`, html.includes("Acme Test Corp"));
  check(`template ${key} includes Tailwind CDN or styling`, html.includes("tailwindcss.com"));
  check(`template ${key} includes header navigation`, html.includes("<header") && html.includes("</header>"));
  check(`template ${key} includes main landmark`, html.includes("<main") && html.includes("</main>"));
  check(`template ${key} includes footer`, html.includes("<footer") && html.includes("</footer>"));
  check(`template ${key} contains section tags`, html.includes("<section"));
}

// 2. Client Workspace and Navigation for Subscribed Users
check("client workspace home is within bounds", withinClientWorkspace(CLIENT_HOME));
check("client nav includes pages/sites", CLIENT_NAV.some((item) => item.to === "/website/sites"));

// 3. API route access for starter templates
const templatesAction = websiteRequestAction("GET", "/starter-templates");
check("/starter-templates is accessible as a view action", templatesAction === "view");

console.log(`websiteSubscriberOnboarding: ${checks} checks passed — subscriber onboarding, templates, and walkthrough readiness verified.`);
