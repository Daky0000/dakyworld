# DakyXTech SEO and AI-search plan

Written 9 October 2026, alongside the repositioning to "Your Technology Team. Without the Overhead." This file lives in `docs/`, which Jekyll excludes, so it is not published at dakyx.com.

## 1. Where the site stands

| Area | State after this pass |
|---|---|
| Titles, descriptions, canonicals, OG/Twitter | Generated per page by `scripts/build-seo.mjs` from each page's own `<title>` and description |
| Structured data | Organization (slogan, contactPoint, knowsAbout), WebSite, ProfessionalService, OfferCatalog of the five service families with anchors, Service with the three plan Offers (intro and regular UnitPriceSpecification) plus Enterprise, FAQPage on every page with `<details>`, BreadcrumbList, BlogPosting |
| Sitemap / robots | Generated. robots.txt names 14 AI search and assistant crawlers explicitly and repeats the Disallow rules for them |
| AI brief | `/llms.txt` rewritten to the new positioning, prices and the rules for what an assistant must not state; linked from every page's head |
| IndexNow | Key file at `/6f1d2c8a94b34e0f8a7c5b1e3d9f2a60.txt`; `npm run indexnow` pings Bing, Yandex, Seznam, Naver and Yep |
| Search console verification | Slots ready for Google, Bing, Yandex and Naver in `VERIFICATION` at the top of `build-seo.mjs`. Codes still needed from the owner |
| `sameAs` | Empty. Needs real profile URLs (LinkedIn company page, X, Facebook, GitHub, Google Business Profile) |

## 2. Connecting the search consoles (owner steps)

1. **Google Search Console** — search.google.com/search-console → Add property → URL prefix `https://dakyx.com/` → HTML tag. Paste the `content` value into `VERIFICATION.google`, run `npm run site`, push, then press Verify. Submit `https://dakyx.com/sitemap.xml` under Sitemaps.
   A Domain property (DNS TXT record) is better long term because it also covers `os.`, `editor.` and `app.`. Add the TXT record at the DNS host named in DOMAINS.md.
2. **Bing Webmaster Tools** — bing.com/webmasters → Import from Google Search Console (fastest), or use the meta-tag option and fill `VERIFICATION.bing`. Bing's index also feeds Copilot, DuckDuckGo and ChatGPT search.
3. **Yandex / Naver** — optional. Same pattern, `VERIFICATION.yandex` / `VERIFICATION.naver`.
4. **After every content deploy**, run `npm run indexnow`.
5. **Google Business Profile** — create one for Kumasi as a service-area business without a public address if preferred. It is the strongest single entity signal for Google and Gemini.

## 3. Positioning and keywords

Primary theme: an external, outsourced technology team. Page-level intent:

| Page | Primary intent | Supporting terms |
|---|---|---|
| `/` | outsourced technology team | external development team, technology partner, managed website and software |
| `/services` | technology services | website development, custom software, business automation, AI workflows, systems integration, technology consulting |
| `/pricing` | technology subscription pricing | monthly technology plans, development retainer, enterprise technology partnership |
| `/about` | who DakyXTech is | founder, Kumasi, external technology team |
| `/insights` | thought leadership | automation, AI adoption, website and software guidance |

The site is positioned globally with no geographic service limit. The Kumasi address stays in schema and the footer because it is true; `areaServed` was removed rather than widened.

## 4. Content plan (next 6 months)

Publishing cadence: two posts a month through `blog/<slug>.md` → `npm run site`.

Cluster hubs and the first posts for each:

1. **External technology team** (hub: `/`): "In-house developer or external technology team: what each costs", "What a monthly technology plan should include", "How to hand over your systems to a technology partner".
2. **Custom software and business systems** (hub: `/services#software`): "When a spreadsheet becomes a business system", "Client portals: when they pay for themselves".
3. **Automation and AI** (hub: `/services#automation`): "Scoping an AI assistant for one business task", "Automation allowances: why monthly limits protect you".
4. **Systems integration** (hub: `/services#integration`): "Connecting payments, CRM and email without retyping", "WhatsApp in a business system: where it fits".
5. **Pricing transparency** (hub: `/pricing`): "Why our plans have fixed prices and fixed limits", "What 'unlimited' really costs in a retainer".

Each post: one question as the H2, a 40–60 word direct answer under it (the passage AI engines quote), then the detail. Link to its hub and to `/pricing`.

## 5. AI search (GEO) checklist

- [x] AI crawlers welcomed by name in robots.txt
- [x] `/llms.txt` current, with rules on what not to state
- [x] FAQPage schema read from the visible FAQs, so on-page and schema answers match
- [x] Direct, quotable answers on pricing, cancellation, ownership and rollover
- [ ] `sameAs` profiles: needed for entity recognition in ChatGPT, Gemini and Perplexity
- [ ] Verified case studies with dates and named sources (decision 8 in the brief). AI engines favour specific, attributable numbers
- [ ] Founder author page (`/about#founder`) with a Person schema, and posts attributed to it
- [ ] Mentions on third-party sites: Clutch, GoodFirms, LinkedIn articles, Ghana tech directories

## 6. Roadmap

| Phase | Weeks | Work |
|---|---|---|
| Foundation | 1–2 | Verify Google and Bing, submit the sitemap, run IndexNow, add `sameAs`, create Google Business Profile |
| Expansion | 3–12 | Two posts a month on the clusters above; author page; first verified case study |
| Scale | 13–24 | Directory listings and backlinks; comparison content; check Core Web Vitals in Search Console |
| Authority | 6–12 months | Guest articles, podcast or event mentions, a downloadable buyer's guide to technology retainers |

## 7. KPIs

| Metric | Baseline | 3 months | 6 months | 12 months |
|---|---|---|---|---|
| Indexed pages (GSC) | measure on verification | all 27 | 35+ | 50+ |
| Organic clicks / month | measure | +50% | 2× | 4× |
| Branded query impressions | measure | tracked | rising | rising |
| AI citations (manual check: ChatGPT, Perplexity, Gemini for "DakyXTech" and 5 category queries) | 0 assumed | named for brand | cited for 1 category query | cited for 3+ |
| Core Web Vitals | measure | all "good" | hold | hold |

## 8. Open decisions from the content brief

Published copy deliberately does not state these, because they are not yet decided. Each needs the owner's approval before it can appear:

1. USD retail amounts and rounding (the site says "ask for a USD quote").
2. Exact monthly work allowance per plan.
3. Included hosting/API budgets and overage handling.
4. Support hours, severity definitions and response targets per tier.
5. Training frequency and onboarding scope.
6. Refund valuation formula and cancellation effective date (terms now defer to the service agreement). Needs legal review.
7. Rule against repeat introductory discounts, and tier changes during the intro period.
8. Evidence and permission for the named clients and the figures on the homepage (30+, 70%, 48h).
9. Customer portal (`app.dakyx.com`) timing. Nothing on the site claims it exists.
10. Legal/financial sign-off for GHS/USD billing.
