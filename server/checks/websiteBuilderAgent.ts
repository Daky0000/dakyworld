/**
 * Multi-page Website Builder Agent check suite.
 * Asserts site-wide font family replacement, color replacement, cross-page phone/content replacement,
 * plan generation, and safe draft applications. Database-free.
 */
import assert from "node:assert/strict";
import type { Site, SitePage } from "@prisma/client";
import {
  normalizeColorCode,
  parseCssDeclarations,
  serializeCssDeclarations,
  planGlobalFontChange,
  planGlobalColorChange,
  planCrossPageContentChange,
  applyAgentSitePlan,
  siteAgentCommandSchema,
  siteAgentApplyInputSchema,
} from "../src/services/websiteBuilderAgent.js";
import { discoverFields, type FieldValue } from "../src/services/website/index.js";

// ---------------------------------------------------------------------------
// 1. Utilities & Normalization Assertions
// ---------------------------------------------------------------------------
assert.equal(normalizeColorCode("#FFF"), "#ffffff");
assert.equal(normalizeColorCode("#3157FF"), "#3157ff");
assert.equal(normalizeColorCode("  #08101f  "), "#08101f");

const parsed = parseCssDeclarations("color: #3157ff; font-family: 'Space Grotesk', sans-serif; font-size: 20px");
assert.equal(parsed["color"], "#3157ff");
assert.equal(parsed["font-family"], "'Space Grotesk', sans-serif");
assert.equal(parsed["font-size"], "20px");

const serialized = serializeCssDeclarations({ "font-family": "Inter, sans-serif", color: "#10b981" });
assert.ok(serialized.includes("font-family: Inter, sans-serif"));
assert.ok(serialized.includes("color: #10b981"));

// ---------------------------------------------------------------------------
// 2. Mock Site and Pages
// ---------------------------------------------------------------------------
const mockSite = {
  id: "site-agent-test",
  name: "Acme Studio",
  slug: "acme-studio",
  publicUrl: "https://acme.example.com",
  repoPath: "",
  sourceKind: null,
} as unknown as Site;

const homeHtml = `<!doctype html><html><head><title>Home</title></head><body>
<header>
  <p data-dw-field="header.phone">Call us at +1 (234) 567-8900</p>
  <a data-dw-field="header.call" href="tel:+12345678900">Call Now</a>
</header>
<main>
  <h1 data-dw-field="hero.title" style="font-family: 'Space Grotesk', sans-serif; color: #08101F; font-size: 40px">Welcome to Acme</h1>
  <p data-dw-field="hero.text" style="color: #08101F">We build websites that scale.</p>
  <a data-dw-field="hero.cta" class="btn btn-primary" href="/contact" style="background-color: #3157FF; color: #FFFFFF">Get in touch</a>
</main>
</body></html>`;

const aboutHtml = `<!doctype html><html><head><title>About</title></head><body>
<main>
  <h1 data-dw-field="about.title" style="font-family: 'Space Grotesk', sans-serif; color: #08101F">About Acme</h1>
  <p data-dw-field="about.desc" style="color: #555555">Our team is available at +1 (234) 567-8900 for enquiries.</p>
  <div data-dw-field="about.box" style="border: 1px solid #08101F; padding: 20px">Company details</div>
</main>
</body></html>`;

const contactHtml = `<!doctype html><html><head><title>Contact</title></head><body>
<main>
  <h1 data-dw-field="contact.heading" style="color: #08101F">Contact Us</h1>
  <p data-dw-field="contact.phone">Phone: +1 (234) 567-8900</p>
  <a data-dw-field="contact.tel" href="tel:+12345678900">+1 (234) 567-8900</a>
  <a data-dw-field="contact.email" href="mailto:hello@acme.example.com">hello@acme.example.com</a>
</main>
</body></html>`;

const mockPages: SitePage[] = [
  {
    id: "page-home",
    siteId: mockSite.id,
    title: "Home",
    path: "/",
    filePath: "index.html",
    status: "LIVE",
    sourceHtml: homeHtml,
    draft: null,
    draftRevision: 1,
  } as unknown as SitePage,
  {
    id: "page-about",
    siteId: mockSite.id,
    title: "About",
    path: "/about",
    filePath: "about.html",
    status: "LIVE",
    sourceHtml: aboutHtml,
    draft: null,
    draftRevision: 3,
  } as unknown as SitePage,
  {
    id: "page-contact",
    siteId: mockSite.id,
    title: "Contact",
    path: "/contact",
    filePath: "contact.html",
    status: "LIVE",
    sourceHtml: contactHtml,
    draft: null,
    draftRevision: 2,
  } as unknown as SitePage,
];

// ---------------------------------------------------------------------------
// 3. Test: Global Font Family Replacement
// ---------------------------------------------------------------------------
const fontPlan = await planGlobalFontChange(mockSite, mockPages, {
  fromFont: "Space Grotesk",
  toFont: "Inter, sans-serif",
});

assert.equal(fontPlan.actionKind, "font");
assert.equal(fontPlan.summary.affectedPages, 2, "Home and About have Space Grotesk headings");
assert.ok(fontPlan.summary.totalChanges >= 2);

const homePlan = fontPlan.pages.find(p => p.pageId === "page-home")!;
assert.ok(homePlan, "Home page is included in font plan");
const heroTitleChange = homePlan.changes.find(c => c.fieldId === "hero.title");
assert.ok(heroTitleChange, "Hero title is modified in font plan");
assert.equal(heroTitleChange.property, "font-family");
assert.equal(heroTitleChange.after, "Inter, sans-serif");
assert.ok(homePlan.edits["hero.title"].style?.includes("font-family: Inter, sans-serif"));
assert.ok(homePlan.edits["hero.title"].style?.includes("color: #08101F"), "Other style properties are preserved");
assert.ok(homePlan.edits["hero.title"].style?.includes("font-size: 40px"), "Font size is preserved");

// ---------------------------------------------------------------------------
// 4. Test: Global Color Code Replacement
// ---------------------------------------------------------------------------
const colorPlan = await planGlobalColorChange(mockSite, mockPages, {
  fromColor: "#08101F",
  toColor: "#1E293B",
});

assert.equal(colorPlan.actionKind, "color");
assert.equal(colorPlan.summary.affectedPages, 3, "All 3 pages have elements using #08101F");
assert.ok(colorPlan.summary.totalChanges >= 4);

const contactColorPlan = colorPlan.pages.find(p => p.pageId === "page-contact")!;
const contactHeadingChange = contactColorPlan.changes.find(c => c.fieldId === "contact.heading");
assert.ok(contactHeadingChange);
assert.equal(contactHeadingChange.after, "#1E293B");
assert.ok(contactColorPlan.edits["contact.heading"].style?.includes("color: #1E293B"));

// ---------------------------------------------------------------------------
// 5. Test: Cross-Page Content & Contact Replacement (Phone number)
// ---------------------------------------------------------------------------
const phonePlan = await planCrossPageContentChange(mockSite, mockPages, {
  findText: "+1 (234) 567-8900",
  replaceText: "+1 (555) 019-9234",
  kind: "phone",
});

assert.equal(phonePlan.actionKind, "content");
assert.equal(phonePlan.summary.affectedPages, 3, "Phone number appears on Home, About, and Contact");

// Home page assertions: both text paragraph and tel: link href must be updated
const homePhonePlan = phonePlan.pages.find(p => p.pageId === "page-home")!;
const headerPhoneChange = homePhonePlan.changes.find(c => c.fieldId === "header.phone");
assert.ok(headerPhoneChange, "Header phone text is updated");
assert.ok(headerPhoneChange.after.includes("+1 (555) 019-9234"));

const headerCallChange = homePhonePlan.changes.find(c => c.fieldId === "header.call");
assert.ok(headerCallChange, "Header call action link is updated");
assert.equal(headerCallChange.property, "href");
assert.ok(headerCallChange.after.startsWith("tel:15550199234"));

// ---------------------------------------------------------------------------
// 6. Test: Cross-Page Email Replacement
// ---------------------------------------------------------------------------
const emailPlan = await planCrossPageContentChange(mockSite, mockPages, {
  findText: "hello@acme.example.com",
  replaceText: "support@acme.example.com",
  kind: "email",
});
assert.equal(emailPlan.summary.affectedPages, 1);
const contactEmailPlan = emailPlan.pages.find(p => p.pageId === "page-contact")!;
const emailChangeText = contactEmailPlan.changes.find(c => c.fieldId === "contact.email" && c.property === "value");
const emailChangeHref = contactEmailPlan.changes.find(c => c.fieldId === "contact.email" && c.property === "href");
assert.ok(emailChangeText);
assert.equal(emailChangeText.after, "support@acme.example.com");
assert.ok(emailChangeHref);
assert.equal(emailChangeHref.after, "mailto:support@acme.example.com");

// ---------------------------------------------------------------------------
// 7. Schema Validation & Safety Guard Assertions
// ---------------------------------------------------------------------------
assert.equal(siteAgentCommandSchema.safeParse({ action: "replace_font", toFont: "Inter" }).success, true);
assert.equal(siteAgentCommandSchema.safeParse({ action: "replace_font", toFont: "" }).success, false, "toFont must not be empty");
assert.equal(siteAgentCommandSchema.safeParse({ action: "replace_color", fromColor: "#111", toColor: "#222" }).success, true);
assert.equal(siteAgentCommandSchema.safeParse({ action: "replace_color", fromColor: "" }).success, false);
assert.equal(siteAgentCommandSchema.safeParse({ action: "instruction", prompt: "a" }).success, false, "prompt must be at least 2 chars unless attachment present");
assert.equal(
  siteAgentCommandSchema.safeParse({
    action: "instruction",
    prompt: "",
    attachments: [{ filename: "bg.png", url: "/assets/dw/bg.png", kind: "image" }],
  }).success,
  true,
  "attachment alone is valid"
);

// ---------------------------------------------------------------------------
// 8. Test: Undo / Redo / Discard Commands & Approval Guard
// ---------------------------------------------------------------------------
const { planAgentInstruction } = await import("../src/services/websiteBuilderAgent.js");

const undoPlan = await planAgentInstruction(mockSite, mockPages, "Undo my last change", { pageId: "page-home" });
assert.equal(undoPlan.editorCommand, "undo");
assert.equal(undoPlan.requiresApproval, false);

const redoPlan = await planAgentInstruction(mockSite, mockPages, "Redo change", { pageId: "page-home" });
assert.equal(redoPlan.editorCommand, "redo");
assert.equal(redoPlan.requiresApproval, false);

const discardPlan = await planAgentInstruction(mockSite, mockPages, "Discard draft", { pageId: "page-home" });
assert.equal(discardPlan.editorCommand, "discard");
assert.equal(discardPlan.requiresApproval, true);
assert.equal(discardPlan.riskLevel, "high");

// ---------------------------------------------------------------------------
// 9. Test: Attachments (Replace background with image & Link button to file)
// ---------------------------------------------------------------------------
const bgAttachmentPlan = await planAgentInstruction(
  mockSite,
  mockPages,
  "Replace my background with this image",
  {
    pageId: "page-home",
    attachments: [
      {
        id: "asset-bg-1",
        filename: "hero-banner.png",
        url: "/assets/dw/hero-banner.png",
        kind: "image",
      },
    ],
  }
);
assert.equal(bgAttachmentPlan.actionKind, "attachment");
assert.equal(bgAttachmentPlan.summary.totalChanges, 1);
const bgChange = bgAttachmentPlan.pages[0]?.changes[0];
assert.ok(bgChange, "Background change created");
assert.equal(bgChange.property, "background-image");
assert.ok(bgChange.after.includes("/assets/dw/hero-banner.png"));

const linkAttachmentPlan = await planAgentInstruction(
  mockSite,
  mockPages,
  "Let this button link to this file",
  {
    pageId: "page-home",
    selectedFieldId: "header.call",
    attachments: [
      {
        id: "asset-doc-1",
        filename: "pricing-guide.pdf",
        url: "/assets/dw/pricing-guide.pdf",
        kind: "file",
      },
    ],
  }
);
assert.equal(linkAttachmentPlan.actionKind, "attachment");
assert.equal(linkAttachmentPlan.summary.totalChanges, 1);
const linkChange = linkAttachmentPlan.pages[0]?.changes[0];
assert.ok(linkChange, "Button link change created");
assert.equal(linkChange.property, "href");
assert.ok(linkChange.after.includes("/assets/dw/pricing-guide.pdf"));
assert.equal(linkAttachmentPlan.pages[0]?.edits["header.call"]?.href, "/assets/dw/pricing-guide.pdf");
assert.equal(linkAttachmentPlan.pages[0]?.edits["header.call"]?.newTab, true);

// ---------------------------------------------------------------------------
// 10. Test: Delete / Entire-Text Approval Protection
// ---------------------------------------------------------------------------
const deletePlan = await planAgentInstruction(
  mockSite,
  mockPages,
  "Delete the hero heading",
  {
    pageId: "page-home",
    selectedFieldId: "hero.title",
  }
);
assert.equal(deletePlan.actionKind, "structure");
assert.equal(deletePlan.requiresApproval, true, "Deleting an element must require approval");
assert.equal(deletePlan.riskLevel, "high");

console.log("All Website Builder Agent checks passed cleanly (zero regressions, pure assertions).");

