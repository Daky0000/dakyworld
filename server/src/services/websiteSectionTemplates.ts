import { randomUUID } from "node:crypto";
import { parseHtml, walk, type ElementNode } from "./website/parse.js";

export type SectionKind =
  | "testimonials"
  | "pricing"
  | "faq"
  | "features"
  | "cta"
  | "contact"
  | "team"
  | "hero";

export type SectionContext = {
  siteName?: string;
  primaryColor?: string;
  /** The site's own phone number and email address, when its pages already show them. */
  phone?: string;
  email?: string;
  /** A fixed id, for a page whose navigation links to the section. */
  id?: string;
};

export type SectionTemplate = {
  kind: SectionKind;
  label: string;
  description: string;
  generateHtml: (context?: SectionContext) => string;
};

/*
 * Ready-made sections: the Builder agent's "add a … section", the editor's own
 * Insert section, and the starter sites.
 *
 * **Everything a business would have to vouch for is a placeholder in square
 * brackets.** These used to carry DakyXTech's own details into customers'
 * pages — hello@dakyx.com as the contact address, a team led by DakyX's
 * founder, DakyX's prices — and five-star reviews from named people who do not
 * exist. Published unedited, that is a business presenting invented
 * endorsements as its own. A heading may say "What our customers say"; a
 * customer's words, a name, a price or a phone number may only come from the
 * business, or stand as "[Customer name]" until they do.
 *
 * **Inline styles, not utility classes.** The sections were Tailwind markup with
 * no stylesheet, so on a page that does not load Tailwind they arrived as
 * unstyled text. Every value put into them is escaped here, so callers pass
 * plain text.
 */

const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const accentOf = (ctx?: SectionContext) => (ctx?.primaryColor && /^#[0-9a-f]{3,8}$/i.test(ctx.primaryColor.trim()) ? ctx.primaryColor.trim() : "#3157ff");
const idOf = (kind: SectionKind, ctx?: SectionContext) =>
  ctx?.id && /^[A-Za-z][\w-]{0,60}$/.test(ctx.id) ? ctx.id : `sec-${kind}-${randomUUID().slice(0, 6)}`;

/** A phone number the section can link to: `tel:` keeps the international `+`. */
function phoneOf(raw?: string): { text: string; tel: string; whatsapp: string | null } | null {
  const text = raw?.trim() ?? "";
  const digits = text.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return null;
  const international = text.startsWith("+");
  // wa.me needs the country code, so a number written without one gets no
  // WhatsApp link rather than one that reaches somebody else.
  return { text, tel: `${international ? "+" : ""}${digits}`, whatsapp: international ? digits : null };
}
const emailOf = (raw?: string) => {
  const text = raw?.trim() ?? "";
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(text) ? text : null;
};

const section = (id: string, inner: string, background = "#ffffff") => `
<section id="${id}" style="padding:64px 20px;background:${background};border-top:1px solid #e2e8f0;">
  <div style="max-width:1080px;margin:0 auto;">
${inner}
  </div>
</section>
`;
const intro = (accent: string, eyebrow: string, title: string, text: string) => `    <div style="text-align:center;max-width:640px;margin:0 auto 40px;">
      <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${accent};">${eyebrow}</p>
      <h2 style="margin:8px 0 0;font-size:32px;line-height:1.2;font-weight:800;color:#0f172a;">${title}</h2>
      <p style="margin:12px 0 0;font-size:16px;line-height:1.6;color:#475569;">${text}</p>
    </div>`;
const grid = (cards: string[], min = 240) => `    <div style="display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(${min}px,1fr));">
${cards.join("\n")}
    </div>`;
const card = (inner: string) => `      <div style="padding:24px;border:1px solid #e2e8f0;border-radius:16px;background:#ffffff;">
${inner}
      </div>`;
const button = (accent: string, label: string, href = "#") =>
  `<a href="${href}" style="display:inline-block;padding:12px 24px;border-radius:12px;background:${accent};color:#ffffff;font-weight:600;text-decoration:none;">${label}</a>`;

export const SECTION_TEMPLATES: Record<SectionKind, SectionTemplate> = {
  testimonials: {
    kind: "testimonials",
    label: "Testimonials",
    description: "Three review cards, each waiting for a real customer's words, name and business.",
    generateHtml: (ctx) => {
      const accent = accentOf(ctx);
      const review = () => card(`        <blockquote style="margin:0;font-size:16px;line-height:1.6;color:#1e293b;">[A customer's own words — use a real review, with their permission]</blockquote>
        <p style="margin:16px 0 0;font-size:14px;font-weight:700;color:#0f172a;">[Customer name]</p>
        <p style="margin:4px 0 0;font-size:13px;color:#64748b;">[Their business or town]</p>`);
      return section(idOf("testimonials", ctx), `${intro(accent, "Reviews", "What our customers say", "[One line on who your customers are]")}
${grid([review(), review(), review()])}`, "#f8fafc");
    },
  },

  pricing: {
    kind: "pricing",
    label: "Pricing",
    description: "Three plan cards, each waiting for a plan name, price and what it includes.",
    generateHtml: (ctx) => {
      const accent = accentOf(ctx);
      const plan = () => card(`        <h3 style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">[Plan name]</h3>
        <p style="margin:8px 0 0;font-size:28px;font-weight:800;color:#0f172a;">[Price]</p>
        <p style="margin:8px 0 0;font-size:14px;line-height:1.6;color:#475569;">[Who this plan is for]</p>
        <ul style="margin:16px 0 20px;padding-left:18px;font-size:14px;line-height:1.8;color:#334155;">
          <li>[What is included]</li>
          <li>[What is included]</li>
          <li>[What is included]</li>
        </ul>
        ${button(accent, "[Button words]")}`);
      return section(idOf("pricing", ctx), `${intro(accent, "Pricing", "[Your pricing headline]", "[One line on how your pricing works]")}
${grid([plan(), plan(), plan()])}`);
    },
  },

  faq: {
    kind: "faq",
    label: "Frequently asked questions",
    description: "Questions that open to show their answers, each waiting for your own.",
    generateHtml: (ctx) => {
      const accent = accentOf(ctx);
      const item = () => `      <details style="padding:16px 20px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff;">
        <summary style="cursor:pointer;font-size:16px;font-weight:700;color:#0f172a;">[A question your customers ask]</summary>
        <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#475569;">[Your answer]</p>
      </details>`;
      return section(idOf("faq", ctx), `${intro(accent, "FAQ", "Frequently asked questions", "[One line inviting other questions]")}
    <div style="display:flex;flex-direction:column;gap:12px;max-width:760px;margin:0 auto;">
${[item(), item(), item(), item()].join("\n")}
    </div>`);
    },
  },

  features: {
    kind: "features",
    label: "Features",
    description: "Three cards for what you do well and why it matters to your customers.",
    generateHtml: (ctx) => {
      const accent = accentOf(ctx);
      const feature = () => card(`        <h3 style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">[Something you do well]</h3>
        <p style="margin:8px 0 0;font-size:15px;line-height:1.6;color:#475569;">[One sentence on why it matters to your customer]</p>`);
      return section(idOf("features", ctx), `${intro(accent, "[What you offer]", "[Why customers choose you]", "[One line summing up your service]")}
${grid([feature(), feature(), feature()])}`);
    },
  },

  cta: {
    kind: "cta",
    label: "Call to action",
    description: "A banner inviting visitors to take the next step.",
    generateHtml: (ctx) => {
      const accent = accentOf(ctx);
      return section(idOf("cta", ctx), `    <div style="padding:40px 28px;border-radius:24px;background:#0f172a;text-align:center;">
      <h2 style="margin:0;font-size:30px;line-height:1.2;font-weight:800;color:#ffffff;">[A short invitation to act]</h2>
      <p style="margin:12px auto 24px;max-width:540px;font-size:16px;line-height:1.6;color:#cbd5e1;">[One line on what happens next]</p>
      ${button(accent, "[Button words]")}
    </div>`);
    },
  },

  contact: {
    kind: "contact",
    label: "Contact details",
    description: "Phone, email and WhatsApp cards — filled with the site's own details where its pages already show them.",
    generateHtml: (ctx) => {
      const accent = accentOf(ctx);
      const phone = phoneOf(ctx?.phone);
      const email = emailOf(ctx?.email);
      const cards = [
        card(`        <h3 style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">Phone</h3>
        <p style="margin:8px 0 0;font-size:15px;color:#334155;">${phone ? `<a href="tel:${esc(phone.tel)}" style="color:${accent};font-weight:600;text-decoration:none;">${esc(phone.text)}</a>` : "[Your phone number]"}</p>`),
        card(`        <h3 style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">Email</h3>
        <p style="margin:8px 0 0;font-size:15px;color:#334155;">${email ? `<a href="mailto:${esc(email)}" style="color:${accent};font-weight:600;text-decoration:none;">${esc(email)}</a>` : "[Your email address]"}</p>`),
        ...(phone?.whatsapp
          ? [card(`        <h3 style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">WhatsApp</h3>
        <p style="margin:8px 0 0;font-size:15px;color:#334155;"><a href="https://wa.me/${phone.whatsapp}" style="color:${accent};font-weight:600;text-decoration:none;">Message us on WhatsApp</a></p>`)]
          : []),
      ];
      return section(idOf("contact", ctx), `${intro(accent, "Contact", "Get in touch", "[When and how you can be reached]")}
${grid(cards)}`, "#f8fafc");
    },
  },

  team: {
    kind: "team",
    label: "Team",
    description: "Three cards for the people behind the business, each waiting for a name, role and line about them.",
    generateHtml: (ctx) => {
      const accent = accentOf(ctx);
      const person = () => card(`        <h3 style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">[Name]</h3>
        <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:${accent};">[Role]</p>
        <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#475569;">[One line about them]</p>`);
      return section(idOf("team", ctx), `${intro(accent, "Team", "[The people behind the business]", "[One line about how you work together]")}
${grid([person(), person(), person()])}`);
    },
  },

  hero: {
    kind: "hero",
    label: "Hero",
    description: "A headline, a sentence and a button for the top of a page.",
    generateHtml: (ctx) => {
      const accent = accentOf(ctx);
      const eyebrow = ctx?.siteName?.trim() ? esc(ctx.siteName.trim()) : "[Your business name]";
      return section(idOf("hero", ctx), `    <div style="text-align:center;max-width:760px;margin:0 auto;">
      <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${accent};">${eyebrow}</p>
      <h1 style="margin:12px 0 0;font-size:44px;line-height:1.1;font-weight:800;color:#0f172a;">[Your headline: what you do, and for whom]</h1>
      <p style="margin:16px auto 28px;max-width:620px;font-size:18px;line-height:1.6;color:#475569;">[A sentence on the result your customers get]</p>
      ${button(accent, "[Button words]")}
    </div>`);
    },
  },
};

/** Elements inside which a `<footer>` belongs to that element, not to the page. */
const CONTENT_ELEMENTS = new Set(["blockquote", "article", "aside", "figure", "section", "li", "details", "dialog", "form", "table", "nav", "header", "footer", "address"]);

/**
 * Puts a new section before the page's own footer, or at the end of its main
 * content.
 *
 * Found by reading the page, not by searching its text. The first `<footer` in
 * a page is very often not the page's footer: a quote's attribution is written
 * `<blockquote>…<footer>Kofi, Osu</footer></blockquote>`, and a card can have
 * one too, so new sections used to land inside a testimonial. The page's footer
 * is the last one with nothing but layout wrappers (`body`, `main`, a `div`)
 * around it.
 */
export function injectSectionIntoHtml(html: string, sectionHtml: string): string {
  const root = parseHtml(html);
  const nodes = [...walk(root)];
  const body = nodes.find((node) => node.tag === "body") ?? null;
  const pageFooter = nodes
    .filter((node) => node.tag === "footer")
    .filter((node) => {
      for (let parent = node.parent; parent && parent !== body && parent !== root; parent = parent.parent) {
        if (CONTENT_ELEMENTS.has(parent.tag)) return false;
      }
      return true;
    })
    .pop();
  const closed = (node: ElementNode | null | undefined): node is ElementNode =>
    Boolean(node && !node.selfClosing && node.end > node.innerEnd && node.innerEnd >= node.innerStart);
  const main = nodes.find((node) => node.tag === "main");
  const at = pageFooter ? pageFooter.start : closed(main) ? main.innerEnd : closed(body) ? body.innerEnd : html.length;
  return `${html.slice(0, at)}${sectionHtml.trim()}\n${html.slice(at)}`;
}

export type StarterTemplateKey = "business" | "saas" | "portfolio" | "local" | "blank";

export interface StarterTemplateInfo {
  key: StarterTemplateKey;
  name: string;
  tagline: string;
  description: string;
  recommendedFor: string;
  sections: SectionKind[];
}

export const STARTER_TEMPLATES: Record<StarterTemplateKey, StarterTemplateInfo> = {
  business: {
    key: "business",
    name: "Modern Business & Consulting",
    tagline: "Corporate, advisory, and professional services",
    description: "High-impact hero with lead capture CTA, core advantage features, client reviews, and direct contact details.",
    recommendedFor: "Consulting firms, corporate agencies, and service providers",
    sections: ["hero", "features", "testimonials", "cta", "contact"],
  },
  saas: {
    key: "saas",
    name: "Digital Product & SaaS",
    tagline: "Software, web apps, and modern digital platforms",
    description: "Product-led hero banner, platform advantages, tiered pricing cards, FAQ accordion, and conversion CTA.",
    recommendedFor: "Tech startups, SaaS founders, and digital product studios",
    sections: ["hero", "features", "pricing", "faq", "cta"],
  },
  portfolio: {
    key: "portfolio",
    name: "Creative Portfolio & Studio",
    tagline: "Designers, photographers, and creative agencies",
    description: "Bold visual showcase, core competencies, team leadership profiles, client reviews, and direct contact inquiry.",
    recommendedFor: "Designers, architects, photographers, and boutique creative studios",
    sections: ["hero", "features", "team", "testimonials", "contact"],
  },
  local: {
    key: "local",
    name: "Local Services & Storefront",
    tagline: "Local businesses, clinics, gyms, and retail",
    description: "Local service headline, core service highlights, clear pricing options, customer reviews, and direct booking contact.",
    recommendedFor: "Medical practices, gyms, salons, contractors, and local storefronts",
    sections: ["hero", "features", "pricing", "testimonials", "contact"],
  },
  blank: {
    key: "blank",
    name: "Clean Minimalist Canvas",
    tagline: "Clean slate with semantic navigation and responsive structure",
    description: "Clean canvas with standard header, minimalist hero, and footer ready for custom sections.",
    recommendedFor: "Developers and designers building custom layouts from scratch",
    sections: ["hero", "cta"],
  },
};

export function generateStarterSiteHtml(options: {
  siteName: string;
  publicUrl?: string;
  templateKey?: string;
  primaryColor?: string;
}): string {
  const templateKey = (options.templateKey && options.templateKey in STARTER_TEMPLATES)
    ? (options.templateKey as StarterTemplateKey)
    : "business";
  const template = STARTER_TEMPLATES[templateKey];
  const siteName = options.siteName.trim() || "My Website";
  const primaryColor = options.primaryColor || "#3157ff";
  const name = esc(siteName);

  // Each section takes a fixed id, because the navigation below links to them.
  const sectionsHtml = template.sections
    .map((kind) => {
      const sec = SECTION_TEMPLATES[kind];
      return sec ? sec.generateHtml({ siteName, primaryColor, id: `sec-${kind}` }) : "";
    })
    .filter(Boolean)
    .join("\n\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    html { scroll-behavior: smooth; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 0; color: #0f172a; background-color: #ffffff; }
  </style>
</head>
<body class="min-h-screen flex flex-col justify-between antialiased">
  <header class="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
      <a href="/" class="font-bold text-lg text-slate-900 tracking-tight">${name}</a>
      <nav class="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
        <a href="#sec-features" class="hover:text-blue-600 transition">Features</a>
        <a href="#sec-testimonials" class="hover:text-blue-600 transition">Reviews</a>
        <a href="#sec-pricing" class="hover:text-blue-600 transition">Pricing</a>
        <a href="#sec-contact" class="hover:text-blue-600 transition">Contact</a>
      </nav>
      <a href="#sec-contact" class="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500 transition shadow-sm">Get Started</a>
    </div>
  </header>
  <main class="flex-1">
${sectionsHtml}
  </main>
  <footer class="bg-slate-900 text-slate-400 py-12 border-t border-slate-800">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
      <p>© ${new Date().getFullYear()} ${name}. All rights reserved.</p>
      <p>Powered by DakyXTech Website Builder</p>
    </div>
  </footer>
</body>
</html>`;
}
