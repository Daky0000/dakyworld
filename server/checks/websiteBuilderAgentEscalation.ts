/**
 * Verification test suite for Website Builder Agent Scope Guardrails,
 * Section Generation Capabilities, and Owner Escalation Reporting.
 */
import assert from "node:assert/strict";
import type { Site, SitePage } from "@prisma/client";
import {
  evaluateBuilderScope,
  isExplicitEscalationRequest,
  matchSectionTemplateRequest,
  planAgentInstruction,
  siteAgentApplyInputSchema,
} from "../src/services/websiteBuilderAgent.js";
import {
  SECTION_TEMPLATES,
  injectSectionIntoHtml,
  type SectionKind,
} from "../src/services/websiteSectionTemplates.js";

async function run() {
  console.log("Starting Website Builder Agent Scope & Escalation Checks...");

  // ---------------------------------------------------------------------------
  // 1. Strict Scope Evaluation Guardrail Assertions
  // ---------------------------------------------------------------------------
  const crmEval = evaluateBuilderScope("Delete CRM lead 492 and blast outbound cold email sequence");
  assert.equal(crmEval.inScope, false, "CRM & Outbound email must be flagged as out-of-scope");
  assert.equal(crmEval.category, "crm_or_leads");

  const payrollEval = evaluateBuilderScope("Pay staff salaries and transfer funds to employee account");
  assert.equal(payrollEval.inScope, false, "Staff payroll must be flagged as out-of-scope");
  assert.equal(payrollEval.category, "billing_or_account");

  const dbEval = evaluateBuilderScope("Drop database table users and restart production server via docker");
  assert.equal(dbEval.inScope, false, "Server/DB administration must be flagged as out-of-scope");
  assert.equal(dbEval.category, "custom_backend");

  const backendMicroserviceEval = evaluateBuilderScope("Build a backend api with postgres database");
  assert.equal(backendMicroserviceEval.inScope, false, "Custom backend microservice must be flagged as out-of-scope");
  assert.equal(backendMicroserviceEval.category, "complex_engineering");

  const inScopeEval1 = evaluateBuilderScope("Change the hero heading to 'World Class Construction' and make it blue");
  assert.equal(inScopeEval1.inScope, true, "Visual heading copy & color must be in scope");

  const inScopeEval2 = evaluateBuilderScope("Add a testimonials section and pricing table to our homepage");
  assert.equal(inScopeEval2.inScope, true, "Section generation must be in scope");

  const inScopeEval3 = evaluateBuilderScope("Change font family to Inter across all pages and optimize SEO description");
  assert.equal(inScopeEval3.inScope, true, "Typography & SEO must be in scope");

  console.log("✓ Scope Guardrails successfully enforce website builder boundary.");

  // ---------------------------------------------------------------------------
  // 2. Explicit Escalation Intent Assertions
  // ---------------------------------------------------------------------------
  assert.equal(isExplicitEscalationRequest("Please escalate this to the owner"), true);
  assert.equal(isExplicitEscalationRequest("send a report to the owner regarding this layout"), true);
  assert.equal(isExplicitEscalationRequest("I want to talk to Dan about this"), true);
  assert.equal(isExplicitEscalationRequest("report to Dan"), true);
  assert.equal(isExplicitEscalationRequest("hand off to developer"), true);
  assert.equal(isExplicitEscalationRequest("change button text to Submit"), false);

  console.log("✓ Explicit Escalation matcher successfully detects owner handoffs.");

  // ---------------------------------------------------------------------------
  // 3. Section Template Matcher & HTML Generation Assertions
  // ---------------------------------------------------------------------------
  assert.equal(matchSectionTemplateRequest("add a pricing table to this page"), "pricing");
  assert.equal(matchSectionTemplateRequest("insert customer testimonials reviews"), "testimonials");
  assert.equal(matchSectionTemplateRequest("generate a modern faq accordion"), "faq");
  assert.equal(matchSectionTemplateRequest("add a features grid"), "features");
  assert.equal(matchSectionTemplateRequest("create a call to action cta banner"), "cta");
  assert.equal(matchSectionTemplateRequest("add a contact section with our phone"), "contact");
  assert.equal(matchSectionTemplateRequest("include our leadership team"), "team");
  assert.equal(matchSectionTemplateRequest("build a new hero banner"), "hero");
  assert.equal(matchSectionTemplateRequest("just change background to red"), null);

  const sectionKeys: SectionKind[] = ["testimonials", "pricing", "faq", "features", "cta", "contact", "team", "hero"];
  for (const key of sectionKeys) {
    const template = SECTION_TEMPLATES[key];
    assert.ok(template, `Template for ${key} must exist`);
    const html = template.generateHtml({ siteName: "DakyXTech Test Site" });
    assert.ok(html.includes("<section"), `Generated HTML for ${key} must have <section>`);
    assert.ok(html.length > 100, `Generated HTML for ${key} must be substantive`);
  }

  // Test intelligent HTML injection
  const baseHtmlWithFooter = `<!doctype html><html><body><main><h1>Welcome</h1></main><footer>Footer</footer></body></html>`;
  const injected = injectSectionIntoHtml(baseHtmlWithFooter, `<section id="test-sec">New Section</section>`);
  assert.ok(injected.indexOf(`id="test-sec"`) < injected.indexOf("<footer"), "Section must be injected before <footer>");

  console.log("✓ Section generation & HTML injection engine passed all checks.");

  // ---------------------------------------------------------------------------
  // 4. Schema Validation: Support for structuralActions and documentHtmlUpdates
  // ---------------------------------------------------------------------------
  const validApplyPayload = {
    pageRevisions: { "page-1": 1 },
    plan: {
      explanation: "Added pricing section to Home",
      pages: [
        {
          pageId: "page-1",
          pageTitle: "Home",
          pagePath: "/",
          draftRevision: 1,
          changes: [
            {
              fieldId: "pricing.title",
              label: "Pricing Title",
              property: "value",
              before: "(New section)",
              after: "Simple, transparent pricing",
            },
          ],
          edits: {
            "pricing.title": { value: "Simple, transparent pricing" },
          },
        },
      ],
      structuralActions: [
        {
          pageId: "page-1",
          pageTitle: "Home",
          kind: "duplicate" as const,
          fieldId: "card.0",
          label: "Pricing Tier Card",
        },
      ],
      documentHtmlUpdates: {
        "page-1": {
          html: "<section>Injected Pricing</section>",
          label: "Added Pricing section",
        },
      },
    },
  };

  const parsed = siteAgentApplyInputSchema.parse(validApplyPayload);
  assert.equal(parsed.plan.pages.length, 1);
  assert.equal(parsed.plan.structuralActions?.length, 1);
  assert.ok(parsed.plan.documentHtmlUpdates?.["page-1"]);

  console.log("✓ Site Agent apply input schema successfully validates structuralActions & documentHtmlUpdates.");

  console.log("All Website Builder Agent checks PASSED successfully!");
}

run().catch((err) => {
  console.error("Check failed:", err);
  process.exit(1);
});
