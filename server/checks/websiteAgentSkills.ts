/**
 * The Builder agent's skills and its picture of the website
 * (`services/websiteAgentSkills.ts`).
 *
 * Both are pure — no model, no database — so this file needs neither:
 *
 *  1. **Skills**: an ordinary request picks the craft it asks for, at most two,
 *     a review always first; the selection decides when the wording does not;
 *     a request about nothing in particular picks nothing, and the agent works
 *     from its brief as it did before.
 *  2. **The site profile**: how a page was built, its language, who the
 *     business says it is, its menu, and the design tokens its stylesheet
 *     names — with a framework's own internal variables left out. Read off
 *     small fixtures and off this repository's real home page.
 *
 *   npx tsx checks/websiteAgentSkills.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILDER_SKILLS,
  builtWith,
  designTokens,
  navigationLabels,
  pageRole,
  pickBuilderSkills,
  siteProfile,
  skillsBlock,
} from "../src/services/websiteAgentSkills.js";

const failures: string[] = [];
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const keys = (prompt: string, selectedKind?: string | null, attachments = 0) =>
  pickBuilderSkills({ prompt, selectedKind, attachments }).map((skill) => skill.key);

// --- 1. Skills -----------------------------------------------------------------
console.log("\nSkills");
{
  check("rewriting a headline is copy", keys("Rewrite the headline in a friendlier tone")[0] === "copy", keys("Rewrite the headline in a friendlier tone").join(","));
  check("a modern look is design", keys("Make the hero look more modern")[0] === "design", keys("Make the hero look more modern").join(","));
  check("moving a block is layout", keys("Move the pricing section above the testimonials").includes("layout"), keys("Move the pricing section above the testimonials").join(","));
  check("a meta description is search", keys("Write a better meta description for Google")[0] === "seo", keys("Write a better meta description for Google").join(","));
  check("contrast for screen readers is accessibility", keys("Check the contrast and make it work for screen readers")[0] === "accessibility", keys("Check the contrast and make it work for screen readers").join(","));
  check("a fade is motion", keys("Add a fade animation when it scrolls into view")[0] === "motion", keys("Add a fade animation when it scrolls into view").join(","));
  check("more enquiries is conversion", keys("Make this section convert better and get more enquiries")[0] === "conversion", keys("Make this section convert better and get more enquiries").join(","));
  check("the phone number on every page is site-wide", keys("Change the phone number on every page of the site")[0] === "navigation", keys("Change the phone number on every page of the site").join(","));

  const review = keys("Review this page and rewrite anything weak");
  check("a review comes first whatever else is asked", review[0] === "review", review.join(","));
  check("and brings the craft it will need", review.includes("copy"), review.join(","));

  check("never more than two", BUILDER_SKILLS.every(() => keys("Review the design, layout, copy, SEO, images, animation and menu of every page").length <= 2));

  check("an attachment is about pictures", keys("Use this for the hero", null, 1)[0] === "media", keys("Use this for the hero", null, 1).join(","));
  check("“make this better” with a picture selected is about the picture", keys("Make this better", "image")[0] === "media", keys("Make this better", "image").join(","));
  check("with a heading selected it is about the words", keys("Make this better", "text")[0] === "copy", keys("Make this better", "text").join(","));
  check("and with nothing selected it picks nothing", keys("Make this better").length === 0, keys("Make this better").join(","));
  check("nothing to say picks nothing", keys("ok thanks").length === 0);

  const block = skillsBlock(pickBuilderSkills({ prompt: "Rewrite the headline" }));
  check("the block names the skill and carries its doctrine", block.includes("Copywriting") && block.includes("Lead with what the visitor gets"));
  check("no skills, no block", skillsBlock([]) === "");
  check(
    "no doctrine tells the agent to invent a fact",
    BUILDER_SKILLS.every((skill) => !/\b(?:invent|make up) (?:a|the)\b(?! address)/i.test(skill.doctrine.replace(/never[^.]*\./gi, ""))),
  );
  check("every doctrine is short enough to ride in a request", BUILDER_SKILLS.every((skill) => skill.doctrine.length <= 900), BUILDER_SKILLS.map((skill) => `${skill.key} ${skill.doctrine.length}`).join(", "));
}

// --- 2. The site profile ---------------------------------------------------------
console.log("\nThe site profile");
{
  const wordpress = `<!doctype html><html lang="fr-FR"><head><title>Boulangerie Martin &amp; Fils – Pain artisanal à Lyon</title>
<meta name="generator" content="WordPress 6.6">
<meta name="description" content="Pain au levain, viennoiseries et pâtisseries faits maison depuis 1987.">
<style>:root{--brand:#0B3D2E;--wp--preset--color--black:#000;--font-heading:"Playfair Display", serif;--radius:12px;--tw-ring-offset-shadow:0 0 #0000}</style>
</head><body class="elementor-kit-5"><header><nav><a href="/">Accueil</a><a href="/nos-pains">Nos pains</a><a href="/contact">Contact</a><a href="/contact">Contact</a></nav></header>
<main><div class="elementor-element"><h1>Le pain comme <em>autrefois</em></h1></div><link rel="stylesheet" href="/wp-content/themes/x/style.css"></main></body></html>`;
  const css = [...wordpress.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]);
  const profile = siteProfile({ home: wordpress, css });

  check("the language is read", profile.language === "fr-FR", String(profile.language));
  check("the title is read, entities decoded", profile.identity.title === "Boulangerie Martin & Fils – Pain artisanal à Lyon", String(profile.identity.title));
  check("the description is read", profile.identity.description?.startsWith("Pain au levain") === true, String(profile.identity.description));
  check("the main heading is read without its markup", profile.identity.heading === "Le pain comme autrefois", String(profile.identity.heading));
  check("the menu is read once each, in order", profile.navigation.join("|") === "Accueil|Nos pains|Contact", profile.navigation.join("|"));
  check("WordPress and Elementor are both seen", profile.builtWith.includes("WordPress") && profile.builtWith.includes("Elementor"), profile.builtWith.join(", "));

  const names = profile.designTokens.map((token) => token.name);
  check("the brand colour is first", names[0] === "--brand", names.join(", "));
  check("the heading font and the radius are kept", names.includes("--font-heading") && names.includes("--radius"), names.join(", "));
  check("a framework's own variables are left out", !names.some((name) => name.startsWith("--wp--") || name.startsWith("--tw-")), names.join(", "));

  const tailwind = `<html lang="en"><body><div id="__next"><div class="flex flex-col items-center px-4 md:px-8"><script src="/_next/static/chunks/main.js"></script></div></div></body></html>`;
  const made = builtWith(tailwind);
  check("Next.js and Tailwind are seen", made.includes("Next.js") && made.includes("Tailwind CSS"), made.join(", "));
  check("a plain page claims nothing", builtWith("<html><body><h1>Hello</h1><p class=\"intro\">Hi</p></body></html>").length === 0);
  check("a page with no nav has no menu", navigationLabels("<html><body><h1>Hello</h1></body></html>").length === 0);
  check("a value that is not a colour, a font or a size is not a token", designTokens([":root{--speed:200ms;--z:10;--brand:#123456}"]).map((token) => token.name).join(",") === "--brand");

  const french = siteProfile({ home: tailwind, open: wordpress });
  check("the open page decides the language", french.language === "fr-FR", String(french.language));
  const empty = siteProfile({ home: "" });
  check("an unreadable site is an empty profile, not a throw", empty.language === null && empty.navigation.length === 0 && empty.designTokens.length === 0);

  // This repository's own home page: a real stylesheet-driven static site.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const homepage = readFileSync(join(root, "index.html"), "utf8");
  const real = siteProfile({ home: homepage, css: [...homepage.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]) });
  check("the real home page has a title", Boolean(real.identity.title), String(real.identity.title));
  check("and a main heading", Boolean(real.identity.heading), String(real.identity.heading));
  check("and a menu", real.navigation.length >= 3, real.navigation.join(" | "));
  check("and a language", Boolean(real.language), String(real.language));
  console.log(`        ${real.identity.title} — menu: ${real.navigation.join(", ")} — ${real.designTokens.length} tokens — ${real.builtWith.join(", ") || "plain HTML"}`);
}

// --- 3. What kind of page --------------------------------------------------------
console.log("\nThe kind of page");
{
  const role = (path: string, title = "") => pageRole({ path, title });
  check("/ is the home page", role("/") === "home page" && role("index.html") === "home page", `${role("/")} ${role("index.html")}`);
  check("/contact.html is the contact page", role("/contact.html") === "contact page", role("/contact.html"));
  check("/pricing is the pricing page", role("/pricing") === "pricing page", role("/pricing"));
  check("/about-us is the about page", role("/about-us") === "about page", role("/about-us"));
  check("/blog is an index and /blog/a-post an article", role("/blog") === "article index" && role("/blog/a-post") === "article", `${role("/blog")} ${role("/blog/a-post")}`);
  check("/privacy is a legal page", role("/privacy.html") === "legal page", role("/privacy.html"));
  check("a title can say it when the path does not", role("/p/17", "Contact us") === "contact page", role("/p/17", "Contact us"));
  check("anything else is a content page", role("/zzz") === "content page", role("/zzz"));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
