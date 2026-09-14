/**
 * The copy on a site an AI built, and whether any of it is editable.
 *
 * A Lovable, Bolt, v0 or Replit export keeps very little of its writing as JSX
 * text. Most of it is in two places the adapter used to refuse outright:
 *
 *     <Hero title="Ship faster" subtitle="…" ctaText="Start free" />
 *     const features = [{ title: "Fast", description: "…" }];
 *
 * Refusing both is safe and useless: the customer opens the file their homepage
 * is in and is shown three fields beside a page full of their own words. So a
 * prop or a key whose NAME reads as content, holding a plain string literal, is
 * now offered.
 *
 * The risk that buys is precise, and it is what these assertions are about: a
 * string that is structure must never be offered because it happened to be a
 * string. `className`, `variant`, `id`, `icon`, `type`, a Tailwind class list —
 * editing any of those breaks a design nobody asked us to touch, and it breaks
 * it invisibly.
 */
import assert from "node:assert/strict";
import { applyJsxValues, discoverJsxFields } from "../src/services/website/index.js";

let passed = 0;
const page = `
import { Hero } from "@/components/Hero";
import { Card } from "@/components/Card";

const features = [
  { icon: "zap", title: "Fast by default", description: "Pages load in under a second." },
  { icon: "shield", title: "Secure", description: "Everything over HTTPS." },
];

const plans = [{ name: "Starter", price: "GHS 450", period: "per month", cta: "Choose Starter" }];

export default function Index() {
  return (
    <main className="min-h-screen bg-background">
      <Hero
        title="Websites that win customers"
        subtitle="We build, connect and improve the systems behind them."
        ctaText="Talk to us"
        ctaHref="/contact"
        variant="centered"
        className="pt-24 md:pt-32"
        id="hero"
      />
      {features.map((feature) => (
        <Card key={feature.title} title={feature.title} icon={feature.icon} />
      ))}
      <p className="text-muted-foreground">Trusted by teams in Accra.</p>
    </main>
  );
}
`;
const found = discoverJsxFields(page, "src/pages/Index.tsx");
const values = found.fields.map((field) => field.value).sort();

// ── What is offered ─────────────────────────────────────────────────────────
assert.ok(values.includes("Websites that win customers")); passed++;
assert.ok(values.includes("We build, connect and improve the systems behind them.")); passed++;
assert.ok(values.includes("Talk to us")); passed++;
assert.ok(values.includes("/contact")); passed++;
// The data arrays, which on a page like this are most of the words.
assert.ok(values.includes("Fast by default") && values.includes("Pages load in under a second.")); passed++;
assert.ok(values.includes("GHS 450") && values.includes("Choose Starter") && values.includes("Starter")); passed++;
// And the ordinary JSX text, exactly as before.
assert.ok(values.includes("Trusted by teams in Accra.")); passed++;

// ── What is not, and must never be ──────────────────────────────────────────
for (const structure of ["centered", "pt-24 md:pt-32", "hero", "zap", "shield", "min-h-screen bg-background", "text-muted-foreground"]) {
  assert.ok(!values.includes(structure), `${structure} is structure and must not be offered as content`); passed++;
}
// A prop whose value comes from code says so rather than going missing.
assert.ok(found.issues.some((issue) => issue.code === "dynamic" && /Card\.title/.test(issue.message))); passed++;

// ── The link rules apply to a prop exactly as to an href ────────────────────
const cta = found.fields.find((field) => field.value === "/contact")!;
assert.equal(cta.kind, "href"); passed++;
assert.equal(applyJsxValues(page, { filePath: "src/pages/Index.tsx", sourceHash: found.sourceHash, changes: [{ fieldId: cta.id, value: "javascript:alert(1)" }] }).problems[0]?.code, "invalid"); passed++;
assert.equal(applyJsxValues(page, { filePath: "src/pages/Index.tsx", sourceHash: found.sourceHash, changes: [{ fieldId: cta.id, value: "/contact us" }] }).changed.length, 0); passed++;

// ── Editing a prop and a data key, and the file still reading as itself ─────
const title = found.fields.find((field) => field.value === "Websites that win customers")!;
const feature = found.fields.find((field) => field.value === "Pages load in under a second.")!;
const edited = applyJsxValues(page, {
  filePath: "src/pages/Index.tsx",
  sourceHash: found.sourceHash,
  changes: [
    { fieldId: title.id, value: "Websites that win customers in Ghana" },
    { fieldId: feature.id, value: 'Pages load in under a second, "properly" fast.' },
  ],
});
assert.deepEqual(edited.problems, []); passed++;
assert.ok(edited.source.includes('title="Websites that win customers in Ghana"')); passed++;
// A quote inside a data string is escaped as JavaScript, not as HTML — the
// value is a string literal in code, and writing `&quot;` there would show the
// entity to the visitor.
assert.ok(edited.source.includes('description: "Pages load in under a second, \\"properly\\" fast."')); passed++;
assert.ok(edited.source.includes('variant="centered"') && edited.source.includes('className="pt-24 md:pt-32"')); passed++;
const after = discoverJsxFields(edited.source, "src/pages/Index.tsx");
assert.equal(after.fields.length, found.fields.length); passed++;
assert.equal(after.fields.find((field) => field.id === title.id)?.value, "Websites that win customers in Ghana"); passed++;

// ── A data file with no markup in it at all ─────────────────────────────────
// Half of these exports keep their copy in `src/data/site.ts`, which has no JSX
// in it and was therefore a file with nothing to edit.
const data = `export const site = {
  name: "Dakyworld",
  tagline: "Your outsourced digital systems team",
  nav: [{ label: "Work", href: "/work" }, { label: "Pricing", href: "/pricing" }],
  apiKey: "sk-not-content",
  theme: { primary: "#0A2540", radius: "12px" },
};`;
const dataFound = discoverJsxFields(data, "src/data/site.ts");
const dataValues = dataFound.fields.map((field) => field.value).sort();
assert.deepEqual(dataValues, ["/pricing", "/work", "Dakyworld", "Pricing", "Work", "Your outsourced digital systems team"]); passed++;
// A key that is not content stays where it is, whatever its value looks like.
assert.ok(!dataValues.includes("sk-not-content") && !dataValues.includes("#0A2540") && !dataValues.includes("12px")); passed++;

// A backtick literal with nothing substituted into it is a static string, and
// it is offered and written back as a backtick literal — the file keeps the
// shape its developer gave it. One with a substitution in it is genuinely
// assembled at build time and is still left alone.
const template = discoverJsxFields("export const copy = { title: `Hello ${name}`, description: `Plain` };", "src/data/copy.ts");
assert.deepEqual(template.fields.map((field) => field.value), ["Plain"]); passed++;
assert.equal(template.fields[0]!.reference.encoding, "javascript-template"); passed++;

console.log(`websiteAiSites: ${passed} component-prop and data-content checks passed`);
