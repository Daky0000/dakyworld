/**
 * The Builder agent's developer-help offer and its section templates.
 *
 * Until 21 Oct 2026 a keyword guard refused, and filed a developer request
 * for, any message containing words like "lead", "salary" or "bank transfer",
 * and a phrase matched anywhere ("let us help", "contact the owner") filed one
 * too. Now nothing is filed except by the person pressing Request developer
 * help; only a message that is wholly a request for a person is answered with
 * the offer.
 */
import assert from "node:assert/strict";
import {
  isExplicitEscalationRequest,
  matchSectionTemplateRequest,
  siteAgentApplyInputSchema,
} from "../src/services/websiteBuilderAgent.js";
import * as agent from "../src/services/websiteBuilderAgent.js";
import {
  SECTION_TEMPLATES,
  injectSectionIntoHtml,
  type SectionKind,
} from "../src/services/websiteSectionTemplates.js";

async function run() {
  console.log("Starting Website Builder Agent Scope & Escalation Checks...");

  // ---------------------------------------------------------------------------
  // 1. Ordinary copy is never refused or filed (audit H1, H2)
  // ---------------------------------------------------------------------------
  assert.equal("evaluateBuilderScope" in agent, false, "the keyword scope guard is gone");
  for (const prompt of [
    // H1: refused as out of scope because of a word on the page.
    "Change the hero heading to 'Lead generation that actually works'",
    "Make the Team Lead title under Kofi's photo bold",
    "On the careers page say the salary is GHS 4,000 a month",
    "Add a line under prices: We accept bank transfer and MoMo",
    "Link the button to our 2025 financial report PDF",
    "Change our tagline to 'The CRM built for Ghanaian shops'",
    "Replace 'oil and gas pipeline services' with 'pipeline engineering'",
    // H2: a help phrase inside the copy filed a request.
    "Change the button text to 'Let us help'",
    "Add a line: For private bookings, contact the owner",
    "Make the CTA say 'Need a developer? Talk to us'",
    "Rename the support heading to 'Request help'",
  ]) {
    assert.equal(isExplicitEscalationRequest(prompt), false, `"${prompt}" is an edit, not a request for a person`);
  }
  console.log("✓ Ordinary copy edits are neither refused nor filed.");

  // ---------------------------------------------------------------------------
  // 2. A message that is wholly a request for a person gets the offer
  // ---------------------------------------------------------------------------
  for (const phrase of ["I need a developer", "Please request developer help.", "hand off to developer", "talk to a human", "escalate this"]) {
    assert.equal(isExplicitEscalationRequest(phrase), true, `"${phrase}" asks for a person`);
  }
  assert.equal(isExplicitEscalationRequest("change button text to Submit"), false);

  console.log("✓ Only a whole-message request for a person is offered developer help.");

  // ---------------------------------------------------------------------------
  // 3. Section Template Matcher & HTML Generation Assertions
  // ---------------------------------------------------------------------------
  // Only an explicit request for a new section inserts one.
  assert.equal(matchSectionTemplateRequest("add a pricing table to this page"), "pricing");
  assert.equal(matchSectionTemplateRequest("insert a customer testimonials section"), "testimonials");
  assert.equal(matchSectionTemplateRequest("generate a modern faq accordion"), "faq");
  assert.equal(matchSectionTemplateRequest("add a features grid"), "features");
  assert.equal(matchSectionTemplateRequest("create a call to action banner"), "cta");
  assert.equal(matchSectionTemplateRequest("add a contact section with our phone"), "contact");
  assert.equal(matchSectionTemplateRequest("add a team section"), "team");
  assert.equal(matchSectionTemplateRequest("build a new hero banner"), "hero");
  assert.equal(matchSectionTemplateRequest("add a services section below the hero"), "features");
  // Requests that only mention a section used to insert one (21 Oct 2026 audit, C2).
  for (const prompt of [
    "put our new phone number 020 555 1234 in the contact section",
    "change the hero image to the new picture i attached",
    "add a question mark to the main heading",
    "update the testimonials with this new review from ama",
    "make the pricing button link to the new pricing page",
    "add 'members get 10% off' under the main heading",
    "include our leadership team",
    "just change background to red",
  ]) assert.equal(matchSectionTemplateRequest(prompt), null, `"${prompt}" must not insert a section`);

  // Nothing a business would have to vouch for is invented: no names, quotes,
  // ratings, prices or contact details that are not the site's own.
  const sectionKeys: SectionKind[] = ["testimonials", "pricing", "faq", "features", "cta", "contact", "team", "hero"];
  const invented = /dakyx|ayipah|kwame mensah|abena osei|emmanuel appiah|kofi owusu|sarah arthur|ama mensah|david osei|founder|★|GHS|\$\d|\d+\s*%|roi\b/i;
  for (const key of sectionKeys) {
    const template = SECTION_TEMPLATES[key];
    assert.ok(template, `Template for ${key} must exist`);
    const html = template.generateHtml({ siteName: "Acme Bakery" });
    assert.ok(html.includes("<section"), `Generated HTML for ${key} must have <section>`);
    assert.ok(!invented.test(html), `the ${key} section invents nothing: ${html.match(invented)?.[0]}`);
    assert.ok(!/\sclass="/.test(html), `the ${key} section styles itself inline, so it renders on a site without Tailwind`);
  }
  assert.ok(SECTION_TEMPLATES.testimonials.generateHtml().includes("[Customer name]"), "a review waits for a real customer");
  assert.ok(SECTION_TEMPLATES.pricing.generateHtml().includes("[Price]"), "a plan waits for a real price");
  assert.ok(SECTION_TEMPLATES.team.generateHtml().includes("[Name]"), "a team card waits for a real person");
  assert.ok(SECTION_TEMPLATES.hero.generateHtml({ siteName: "<script>x</script>" }).includes("&lt;script&gt;"), "the site name is escaped");
  assert.ok(SECTION_TEMPLATES.faq.generateHtml({ id: "sec-faq" }).includes('id="sec-faq"'), "a fixed id is kept, for navigation links");

  // Contact: the site's own details when it has them, placeholders when not.
  const ownContact = SECTION_TEMPLATES.contact.generateHtml({ phone: "+233 24 123 4567", email: "hello@ama.example" });
  assert.ok(ownContact.includes('href="tel:+233241234567"'), "tel: keeps the international +");
  assert.ok(ownContact.includes('href="mailto:hello@ama.example"'));
  assert.ok(ownContact.includes('href="https://wa.me/233241234567"'));
  const localContact = SECTION_TEMPLATES.contact.generateHtml({ phone: "024 123 4567" });
  assert.ok(localContact.includes('href="tel:0241234567"') && !localContact.includes("wa.me"), "no WhatsApp link without a country code");
  const noContact = SECTION_TEMPLATES.contact.generateHtml();
  assert.ok(noContact.includes("[Your phone number]") && noContact.includes("[Your email address]"));
  assert.ok(!/tel:|mailto:|wa\.me/.test(noContact), "and links nowhere");

  // Placement: before the page's own footer, never a quote's.
  const section = `<section id="test-sec">New Section</section>`;
  const before = (html: string, marker: string) => html.indexOf(`id="test-sec"`) < html.indexOf(marker);
  const quoteFooter = `<!doctype html><html><body><main><section><blockquote><p>Best jollof.</p><footer>Kofi, Osu</footer></blockquote></section></main><footer><p>Page footer</p></footer></body></html>`;
  const placed = injectSectionIntoHtml(quoteFooter, section);
  assert.ok(placed.indexOf(`id="test-sec"`) > placed.indexOf("</blockquote>") && before(placed, "<footer><p>Page footer"), "a quote's footer is not the page's");
  const wrapped = `<!doctype html><html><body><div id="app"><main><h1>Hi</h1></main><footer>Page footer</footer></div></body></html>`;
  assert.ok(before(injectSectionIntoHtml(wrapped, section), "<footer>Page footer"), "a footer inside a layout wrapper is still the page's");
  const noFooter = `<!doctype html><html><body><main><h1>Hi</h1></main><p>After main</p></body></html>`;
  const inMain = injectSectionIntoHtml(noFooter, section);
  assert.ok(before(inMain, "</main>"), "with no footer it goes at the end of main");
  const bare = `<!doctype html><html><body><h1>Hi</h1></body></html>`;
  assert.ok(before(injectSectionIntoHtml(bare, section), "</body>"), "and with no main, at the end of the body");
  assert.ok(injectSectionIntoHtml(bare, "<section>$& and $`</section>").includes("$& and $`"), "spliced by offset, so $ patterns stay as written");

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
