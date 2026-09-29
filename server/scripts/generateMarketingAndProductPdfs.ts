import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const BRAIN_DIR = "C:/Users/ASUS/.gemini/antigravity/brain/994ce6cb-b3a3-45aa-9a2e-16306bed73b5";
const ROOT_DIR = "c:/Users/ASUS/Pictures/Dakyworld";

// ==========================================
// HELPER: Auto-paging & Section Builders
// ==========================================
class PdfBuilder {
  doc: PDFKit.PDFDocument;
  pageWidth: number;
  pageHeight: number;
  margin: number;
  contentWidth: number;
  y: number;
  headerCategory: string;
  docTitle: string;
  pageNumber: number;

  constructor(docTitle: string, headerCategory: string) {
    this.docTitle = docTitle;
    this.headerCategory = headerCategory;
    this.pageNumber = 1;
    this.margin = 36;
    this.doc = new PDFDocument({
      size: "A4",
      margin: this.margin,
      autoFirstPage: true,
      bufferPages: true,
      info: {
        Title: docTitle,
        Author: "Dan Kwame Ayipah · Dakyworld OS",
        Subject: "Global Marketing, Sales & Product Growth Engine",
      },
    });

    this.pageWidth = this.doc.page.width; // 595.28
    this.pageHeight = this.doc.page.height; // 841.89
    this.contentWidth = this.pageWidth - this.margin * 2; // 523.28
    this.y = this.margin;
  }

  ensureSpace(neededHeight: number) {
    if (this.y + neededHeight > this.pageHeight - 45) {
      this.addNextPage();
    }
  }

  addNextPage() {
    this.doc.addPage();
    this.pageNumber++;
    this.drawRunningHeader();
    this.y = 52;
  }

  drawCoverHeader(kicker: string, title: string, subtitle: string, accentColor = "#B8FF3D") {
    // Navy Banner
    this.doc.rect(0, 0, this.pageWidth, 115).fill("#08101F");
    this.doc.rect(0, 111, this.pageWidth, 4).fill(accentColor);

    this.doc
      .fillColor(accentColor)
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .text(kicker.toUpperCase(), 36, 22, { characterSpacing: 1.1 });

    this.doc
      .fillColor("#F8FAFC")
      .font("Helvetica-Bold")
      .fontSize(18)
      .text(title, 36, 36, { width: this.contentWidth, lineGap: 2 });

    this.doc
      .fillColor("#94A3B8")
      .font("Helvetica")
      .fontSize(9)
      .text(subtitle, 36, 78, { width: this.contentWidth, lineGap: 1.5 });

    this.doc
      .fillColor("#E2E8F0")
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .text("OFFICIAL PRICING & TIERS: dakyworld.com/pricing  •  GLOBAL CLIENT COVERAGE", 36, 96);

    this.y = 130;
  }

  drawRunningHeader() {
    this.doc
      .fillColor("#94A3B8")
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .text(`${this.headerCategory.toUpperCase()}  |  ${this.docTitle.toUpperCase()}`, 36, 20);
    this.doc.strokeColor("#E2E8F0").lineWidth(0.5).moveTo(36, 32).lineTo(this.pageWidth - 36, 32).stroke();
  }

  drawSectionHeading(title: string, sub?: string) {
    this.ensureSpace(sub ? 42 : 28);
    this.doc.fillColor("#08101F").font("Helvetica-Bold").fontSize(13).text(title, 36, this.y);
    this.y += 16;
    if (sub) {
      this.doc.fillColor("#64748B").font("Helvetica").fontSize(8.5).text(sub, 36, this.y);
      this.y += 14;
    }
    this.y += 4;
  }

  drawCalloutBox(title: string, body: string, bg = "#F8FAFC", stroke = "#CBD5E1", titleColor = "#0F172A") {
    this.ensureSpace(55);
    const boxY = this.y;
    this.doc.font("Helvetica").fontSize(8.5);
    const bodyHeight = this.doc.heightOfString(body, { width: this.contentWidth - 24, lineGap: 1.5 });
    const totalBoxH = bodyHeight + 30;

    this.doc.roundedRect(36, boxY, this.contentWidth, totalBoxH, 5).fillAndStroke(bg, stroke);
    this.doc.fillColor(titleColor).font("Helvetica-Bold").fontSize(9.5).text(title, 48, boxY + 8);
    this.doc.fillColor("#334155").font("Helvetica").fontSize(8.5).text(body, 48, boxY + 22, {
      width: this.contentWidth - 24,
      lineGap: 1.5,
    });

    this.y += totalBoxH + 10;
  }

  drawPromptBox(title: string, code: string) {
    this.doc.font("Courier").fontSize(7.5);
    const codeHeight = this.doc.heightOfString(code, { width: this.contentWidth - 24, lineGap: 1.2 });
    const totalH = codeHeight + 32;

    if (totalH > 350) {
      // Split or ensure at least header fits
      this.ensureSpace(120);
    } else {
      this.ensureSpace(totalH);
    }

    const boxY = this.y;
    this.doc.roundedRect(36, boxY, this.contentWidth, totalH, 5).fillAndStroke("#0F172A", "#334155");

    this.doc.fillColor("#38BDF8").font("Helvetica-Bold").fontSize(8.5).text(title.toUpperCase(), 48, boxY + 8);
    this.doc.fillColor("#F1F5F9").font("Courier").fontSize(7.2).text(code, 48, boxY + 22, {
      width: this.contentWidth - 24,
      lineGap: 1.2,
    });

    this.y += totalH + 12;
  }

  drawBullet(label: string, text: string) {
    this.ensureSpace(24);
    this.doc.fillColor("#08101F").font("Helvetica-Bold").fontSize(8.5).text(`• ${label}: `, 44, this.y, { continued: true });
    this.doc.fillColor("#334155").font("Helvetica").fontSize(8.5).text(text, { width: this.contentWidth - 20, lineGap: 1.2 });
    this.y = this.doc.y + 4;
  }

  finalize(outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Draw running footers across all buffered pages safely without triggering page breaks
      const range = this.doc.bufferedPageRange();
      const totalPages = range.count;
      for (let i = 0; i < totalPages; i++) {
        this.doc.switchToPage(i);
        const oldBottom = this.doc.page.margins.bottom;
        this.doc.page.margins.bottom = 0;

        // Footer line
        this.doc
          .strokeColor("#CBD5E1")
          .lineWidth(0.5)
          .moveTo(36, this.pageHeight - 26)
          .lineTo(this.pageWidth - 36, this.pageHeight - 26)
          .stroke();

        this.doc
          .fillColor("#64748B")
          .font("Helvetica")
          .fontSize(7.5)
          .text("Dakyworld OS  •  Global Revenue & Growth Engine  •  dakyworld.com/pricing", 36, this.pageHeight - 20, {
            lineBreak: false,
          });

        this.doc
          .fillColor("#64748B")
          .font("Helvetica-Bold")
          .fontSize(7.5)
          .text(`Page ${i + 1} of ${totalPages}`, this.pageWidth - 120, this.pageHeight - 20, {
            width: 84,
            align: "right",
            lineBreak: false,
          });

        this.doc.page.margins.bottom = oldBottom;
      }

      const stream = fs.createWriteStream(outputPath);
      this.doc.pipe(stream);
      this.doc.end();
      stream.on("finish", resolve);
      stream.on("error", reject);
    });
  }
}

// ==========================================
// DOCUMENT 1: 90-Day Global Plan & Prompts
// ==========================================
async function buildGlobalMarketingSalesPlan(outPaths: string[]) {
  const p = new PdfBuilder("Global 90-Day Marketing & Sales Plan", "Dakyworld Revenue Engine");

  // Page 1: Cover & Strategic Architecture
  p.drawCoverHeader(
    "Global B2B Revenue Playbook  •  Days 1 to 90",
    "90-Day Marketing & Sales Execution Blueprint",
    "A systematic execution engine covering international brand awareness, multi-channel inbound/outbound, and AI master prompts.",
    "#B8FF3D"
  );

  p.drawCalloutBox(
    "GLOBAL POSITIONING & COMMERCIAL PRICING DOCTRINE",
    "Dakyworld serves digital agencies, freelancers, and high-growth companies worldwide. To maintain seamless global scalability and multi-currency flexibility, all specific pricing and tier allowances are maintained exclusively on the live Pricing Page (dakyworld.com/pricing). All top-of-funnel content and outreach drive prospects to the Pricing Page and interactive sandbox demo.",
    "#F0FDF4",
    "#86EFAC",
    "#166534"
  );

  p.drawSectionHeading("1. The Three Operational Truths & Approved Proof Points", "Strict data boundaries to maintain B2B credibility across global markets.");
  p.drawBullet("70% Manual Work Removed", "Achieved by replacing manual form-to-CRM-to-spreadsheet copy-pasting with automated webhooks.");
  p.drawBullet("30+ Qualified Inquiries/Month", "Generated through mobile-responsive pages and direct WhatsApp ChatBridge routing.");
  p.drawBullet("30+ Hours Returned Every Month", "Eliminating repetitive team admin so leadership focuses on core billable client delivery.");

  p.drawSectionHeading("2. 90-Day Strategic Revenue Phasing", "The structured three-phase growth trajectory.");

  p.drawCalloutBox(
    "PHASE 1: DAYS 1 TO 30 — INFRASTRUCTURE, SEEDING & EARLY ADOPTER PUSH",
    "• Audit public channels: LinkedIn, Instagram/Facebook, YouTube, and WhatsApp Business.\n• Deploy WhatsApp ChatBridge CRM on all entry touchpoints to prevent mobile lead drop-off.\n• Seed the Website Builder as a frictionless entry point for modern marketing teams.\n• Launch the Flagship Partner Campaign: 3 select clients onboarded with custom roadmaps.\n• Daily Outbound Routine: 5 evidence-backed, constructive audits sent per day (no generic spam).",
    "#F8FAFC",
    "#E2E8F0"
  );

  p.drawCalloutBox(
    "PHASE 2: DAYS 31 TO 60 — ACCELERATION, TEARDOWNS & VIDEO ENGINE",
    "• Video Teardown Machine: 30-45s vertical micro-clips (TikTok/Reels) + 3-5 min Loom/YouTube architecture breakdowns.\n• 'The 30-Hour Math' Campaign: Showing real before/after workflow diagrams where manual work was removed.\n• Deploy Middle-Funnel Lead Magnets: Systems Health Checklists and interactive ROI audits.\n• Mid-point Retainer Upgrades: Transitioning Website Builder users into full Foundation/Growth monthly care.",
    "#F8FAFC",
    "#E2E8F0"
  );

  p.drawCalloutBox(
    "PHASE 3: DAYS 61 TO 90 — SCALE, CASE STUDIES & ENTERPRISE UPGRADES",
    "• Publish deep-dive case studies showcasing verified operational transformations.\n• Multi-site & Enterprise Outreach: Targeting multi-branch companies and agencies.\n• Referral Flywheel: Active partners receive service credits or custom integrations for referring new accounts.\n• Contract Transitions: Smoothly transitioning early cohorts into standard long-term monthly retainers.",
    "#F8FAFC",
    "#E2E8F0"
  );

  // Next Page: Daily Battle Rhythm & Prompts
  p.addNextPage();
  p.drawSectionHeading("3. The Daily 60-Minute Sales & Marketing Battle Rhythm", "Sustainable daily execution that generates qualified pipeline without burning out.");

  p.drawBullet("08:00 – 08:20 GMT (Publish & Engage)", "Publish daily scheduled post across LinkedIn and IG/FB. Respond to all comments within 24 hours.");
  p.drawBullet("08:20 – 09:00 GMT (Evidence Outbound)", "Audit 3 targeted companies. Note 1 specific UX or workflow flaw. Send 3 personalized Touch 1 messages.");
  p.drawBullet("14:00 – 14:30 GMT (Follow-up Cadence)", "Deliver Day 3 visual screenshot fixes to responsive leads; send Day 8 comparable scenario breakdowns.");
  p.drawBullet("16:30 – 17:00 GMT (Pipeline & Proposals)", "Review ChatBridge WhatsApp leads, respond to DMs, and issue 24-hour written proposals following calls.");

  p.drawSectionHeading("4. Master AI Prompt Vault (Engineered for Claude, Gemini & Perplexity)", "System instructions and production prompts with strict stop-slop guardrails.");

  p.drawPromptBox(
    "PROMPT 00 · MASTER SYSTEM CONTEXT (PASTE INTO CLAUDE PROJECT / GEMINI GEM)",
    `You are the Chief Marketing Officer and Lead Systems Architect for Dakyworld (dakyworld.com / os.dakyworld.com / dakyworld.com/pricing), writing in the authentic voice of Dan Kwame Ayipah, Founder of Dakyworld, serving digital agencies, freelance web creators, and growing businesses worldwide.

1. BRAND POSITIONING & GLOBAL VALUE PROPOSITION:
- Identity: "Your outsourced digital systems and automation partner for growing companies, agencies, and lean teams worldwide."
- Promise: "One partner. Better digital systems."
- The Problem We Solve: Businesses and agencies globally struggle with two chronic issues: (1) Brittle websites and CMS bloat where updates break production layouts or depend on unresponsive developers, and (2) Disconnected software where teams waste hours manually retyping client data across forms, spreadsheets, CRMs, and messaging apps.
- What Dakyworld Does: We design high-speed visual web platforms, automate lead-to-cash workflows, connect operational tools (WhatsApp ChatBridge CRM, databases, payment gateways), and provide ongoing monthly engineering capacity under transparent partnerships.

2. COMMERCIAL OFFER & PRICING DOCTRINE:
- Single Source of Truth: All commercial pricing, tier quotas, and promotional discounts are maintained exclusively on our live Pricing Page (dakyworld.com/pricing).
- Marketing Copy Rule: In organic social posts, short videos, and outbound messages, NEVER hardcode static prices or lock content to a single local currency. Always direct viewers and prospects to dakyworld.com/pricing to compare Starter, Pro, and Business tier plans, test the sandbox, or book a consultation.

3. THE ONLY 3 APPROVED PROOF POINTS:
- "70% of manual work removed on a single automation workflow."
- "30+ qualified enquiries per month from an improved customer journey."
- "30+ hours returned every month through workflow automation."

4. TONE & STYLE (STOP-SLOP DOCTRINE):
- Language: British English spelling (optimise, programme, enquiries, organisation).
- Mood: Calm, observant, specific, peer-to-peer. Sounds like a senior systems engineer speaking directly to a busy Founder or Agency Director.
- Absolute Bans: ZERO exclamation marks (!). ZERO emojis in professional body copy.
- Banned AI Jargon: leverage, synergy, seamless, robust, cutting-edge, revolutionize, digital landscape, unlock, game-changer, delve, tapestry, "in today's fast-paced world", "not only... but also".`
  );

  // Next Page: Master Prompts 1, 2, 3, 4
  p.addNextPage();
  p.drawPromptBox(
    "MASTER PROMPT 1 · INSTAGRAM & FACEBOOK CAROUSELS & POSTS",
    `Act as Dakyworld's Social Content Director using the Dakyworld Master System Context.

TASK: Create a 5-Slide Educational Carousel and matching Feed Caption for Instagram & Facebook on:
TOPIC: [INSERT TOPIC, e.g. "5 Hidden Bottlenecks on Modern SME Websites" / "The Agency Margin Trap: Why Client Handoffs Break"]
TARGET AUDIENCE: [Agencies / Freelance Designers / High-growth company founders globally]

OUTPUT STRUCTURE:
1. 5-SLIDE CAROUSEL:
- Slide 1: Dark Navy (#08101F) cover with bone-white text (#F4F5F0). Provocative, unhyped hook.
- Slide 2: The exact friction point occurring inside their company right now.
- Slide 3: The hidden operational or financial cost of this disconnect.
- Slide 4: The Dakyworld engineered fix (clean workflow diagram in plain English). Include ONE approved proof point.
- Slide 5: Clear call-to-action directing to compare plans at dakyworld.com/pricing or DM keyword "FLOW".
2. FEED CAPTION (140-180 words): Plain-English deconstruction. Zero exclamation marks. Directs to pricing page.
3. VISUAL ASSET DIRECTION: Layout notes for Figma/Canva with UI mockup references.`
  );

  p.drawPromptBox(
    "MASTER PROMPT 2 · HIGH-AUTHORITY B2B LINKEDIN SHORT CONTENT",
    `Act as Dan Kwame Ayipah, Founder of Dakyworld, writing on LinkedIn using the Dakyworld Master System Context.

TASK: Write an authoritative B2B LinkedIn post based on this raw observation or theme:
TOPIC: [INSERT OBSERVATION, e.g. "Why growing businesses keep retyping orders between WhatsApp and Excel" / "The true cost of a $5,000 custom website without an engineering partner"]

CONSTRAINTS:
1. Length: 130 to 200 words maximum.
2. Hook: 1-2 lines. Calm, counter-intuitive operational observation. No clickbait.
3. The Scene: Concrete scenario showing where information gets stuck in a growing business.
4. The Systems Insight: Why buying another tool doesn't fix disconnected data. Show the architectural fix.
5. Close: Direct interested founders to explore our approach and live tier plans on dakyworld.com/pricing.
6. Tone: Senior systems engineer to Managing Director. British English. Zero exclamation marks. Zero emojis.`
  );

  p.addNextPage();
  p.drawPromptBox(
    "MASTER PROMPT 3 · HIGH-RETENTION VIDEO SCRIPTS (YOUTUBE, TIKTOK, REELS)",
    `Act as Dakyworld's Video Production Strategist using the Dakyworld Master System Context.

TASK: Write a complete video script for:
FORMAT: [SELECT: "30-60s Short-Form Reel/TikTok" OR "3-5 Minute YouTube/Loom Walkthrough"]
TOPIC: [e.g. "Dakyworld Website Builder Demo: Live Headline Edit in 15 Seconds" OR "Connecting WhatsApp to CRM Automatically"]

OUTPUT REQUIREMENTS:
1. VIDEO METADATA: High-curiosity title + 3-word on-screen hook.
2. TIMECODED TABLE:
   - [Timestamp]: e.g., 0:00 - 0:05
   - [Screen Action]: Visual framing (screen split, live browser canvas, mobile viewport).
   - [Spoken Voiceover]: Word-for-word transcript in Dan's calm, observant voice.
3. PRODUCTION PACING:
   - 0-3s Visual Hook (stop the scroll with immediate UI action).
   - 10-25s Agitation of the problem (developer delays, broken plugins).
   - 25-45s Live demonstration of speed/control on Dakyworld UI.
   - Final 10s: Direct viewers to test the sandbox and compare tiers on dakyworld.com/pricing.`
  );

  p.drawPromptBox(
    "MASTER PROMPT 4 · SUBSCRIBER NEWSLETTERS (EMAIL NURTURE & RETENTION)",
    `Act as Dan Kwame Ayipah writing the Dakyworld Systems Briefing email newsletter.

TASK: Write an email newsletter for our database of registered users, trial subscribers, and business leads.
TOPIC: [INSERT TOPIC, e.g. "The Architecture of a Scalable Lead Engine" / "Why We Retired Cybersecurity to Focus 100% on Flow"]
EDITION: [e.g., Issue #05]

STRUCTURE:
1. Subject Lines: 3 options (Option A: 2-4 lowercase boring words; Option B: Curiosity hook; Option C: Problem statement).
2. Preview Text: Under 80 characters.
3. Field Observation: A specific real-world bottleneck observed over the past fortnight.
4. The Systems Lesson: Contrast "The Common Fix" (buying more software) with "The Engineered Fix" (connecting tools).
5. The Proof: Cite ONE approved proof point naturally.
6. Commercial Capacity Update: Transparent status on current monthly partner capacity and link to dakyworld.com/pricing.
7. Postscript (P.S.): High-converting closing note with a direct reply question.`
  );

  for (const outPath of outPaths) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await p.finalize(outPath);
  }
}

// ==========================================
// DOCUMENT 2: Website Builder Dedicated Playbook
// ==========================================
async function buildWebsiteBuilderPlaybook(outPaths: string[]) {
  const p = new PdfBuilder("Dakyworld Website Builder — Dedicated Product Playbook", "Dakyworld Product Engine");

  // Page 1: Product Positioning & Segmentation
  p.drawCoverHeader(
    "Dedicated SaaS Product Playbook  •  Global Edition",
    "Website Builder GTM & Growth Playbook",
    "Product positioning, ICP segmentation (Agencies, Freelancers, Companies), multi-channel master prompts, and pricing page funnel.",
    "#0284C7"
  );

  p.drawCalloutBox(
    "THE CORE PRODUCT PROMISE: THE HYBRID VISUAL FLOW",
    "Dakyworld Website Builder bridges visual simplicity for non-technical clients with developer-grade code control (raw HTML/CSS/React/Astro source editor, GitHub PR publishing workflow). Clients get a clean visual canvas they cannot break; developers retain full version-controlled code integrity.",
    "#F0F9FF",
    "#BAE6FD",
    "#0369A1"
  );

  p.drawSectionHeading("1. Three-Pronged ICP Segmentation & Value Matrix", "How Dakyworld solves acute friction for Agencies, Freelancers, and Companies.");

  p.drawCalloutBox(
    "ICP 1: DIGITAL AGENCIES (THE ZERO-BREAKAGE CLIENT HANDOFF)",
    "• Pain: 50+ client WordPress sites breaking after core updates; constant tickets for minor text/image edits.\n• Solution: Hand clients an editor where they can only modify text, buttons, and media without altering core grid layouts.\n• Developer Control: Agencies manage source code and approve changes via GitHub Pull Requests.\n• Core Hook: 'Protect your agency margins: Let clients edit their own copy without giving them the keys to break production code.'\n• CTA: Direct to test multi-site agency tiers at dakyworld.com/pricing.",
    "#FAF5FF",
    "#E9D5FF",
    "#6B21A8"
  );

  p.drawCalloutBox(
    "ICP 2: FREELANCE DESIGNERS & DEVELOPERS (DELIVER IN HOURS, RETAIN FOR YEARS)",
    "• Pain: Spending 3 weeks on repetitive CSS boilerplate; unpaid client support calls 6 months after delivery.\n• Solution: Rapid visual deployment with full exportable code control, built-in media library storage, and SEO audits.\n• Recurring Revenue: Bundle Dakyworld hosting and WhatsApp ChatBridge into monthly client care packages.\n• Core Hook: 'Deliver client sites 3x faster, hand off a clean visual editor they can't break, and collect monthly care retainers.'\n• CTA: Direct to compare freelancer plans on dakyworld.com/pricing.",
    "#F0FDF4",
    "#BBF7D0",
    "#15803D"
  );

  p.drawCalloutBox(
    "ICP 3: COMPANIES & IN-HOUSE TEAMS (MARKETING VELOCITY)",
    "• Pain: Marketing teams waiting 2 weeks on external developers just to update pricing or landing page copy.\n• Solution: Click, edit, preview across desktop/tablet/mobile, and publish live in 30 seconds from any browser.\n• Lead Capture: Instant integration with WhatsApp ChatBridge CRM for real-time customer routing.\n• Core Hook: 'Stop waiting on developers for simple edits. Give your marketing team instant visual control while keeping code clean.'\n• CTA: Direct to explore self-serve plans on dakyworld.com/pricing.",
    "#FFFBEB",
    "#FDE68A",
    "#B45309"
  );

  // Next Page: Tier Alignment & Master Prompts for Website Builder
  p.addNextPage();
  p.drawSectionHeading("2. Website Builder Tier Plans & Feature Alignment", "Structured subscription tiers maintained on dakyworld.com/pricing.");

  p.drawBullet("Starter Tier (Editor)", "Visual drag-and-drop editor, floating structure/layers panel, container inspector (flex/grid), 50 MB media storage, live responsive preview. Built for single-site businesses.");
  p.drawBullet("Pro Tier (Care - Most Popular)", "Everything in Starter + Global CSS theme palette, bulk SEO alt-text auto-fixer, 500 MB media storage, AI copywriting assistant (50 prompts/mo). Ideal for growing brands and freelancers.");
  p.drawBullet("Business / Agency Tier (Managed)", "Everything in Pro + Autonomous AI Builder Agent, raw HTML/CSS/React/Astro source code editor, GitHub PR review workflow, 5 GB storage, unlimited imports/edits, and multi-site management.");
  p.drawBullet("Modular Add-on: WhatsApp ChatBridge CRM", "Direct-to-WhatsApp conversational lead generation with context-aware prompts, business hours, and offline inquiries inbox.");

  p.drawSectionHeading("3. Dedicated Website Builder AI Master Prompts", "Specialized prompt suite for Agencies, Freelancers, and Companies.");

  p.drawPromptBox(
    "PROMPT WB-00 · WEBSITE BUILDER SYSTEM CONTEXT",
    `You are the Lead Product Marketing Strategist for Dakyworld Website Builder (os.dakyworld.com / dakyworld.com/pricing).
You write authoritative, high-conversion content targeting digital agencies, freelance web developers, and modern companies worldwide.

PRODUCT CORE IDENTITY:
- The modern hybrid website builder bridging visual simplicity for non-technical clients with developer-grade code control (raw HTML/CSS/React/Astro source editor, GitHub PR publishing workflow).
- Key Capabilities: Visual drag-and-drop & click-to-edit canvas, floating draggable layers panel, container flex/grid inspector, global theme CSS color palettes, bulk SEO alt-text auto-fixer, AI copywriting & layout agent, and WhatsApp ChatBridge CRM integration.
- Pricing Doctrine: Commercial pricing is maintained exclusively on our live Pricing Page (dakyworld.com/pricing). Direct all users, prospects, and viewers to the Pricing Page for tier comparisons, sandbox access, and feature allowances. Do not invent or hardcode fixed prices in social copy.

TONE & STYLE:
- Professional, observant, clean, peer-to-peer.
- British English spelling.
- Zero exclamation marks (!). Zero hype emojis.
- Banned Buzzwords: revolutionary, seamless, game-changer, unlock, leverage, supercharge, digital landscape.
- Focus on operational reality: reduced support tickets, faster delivery cycles, developer sanity, client autonomy.`
  );

  // Next Page: Prompts WB-01, WB-02, WB-03
  p.addNextPage();
  p.drawPromptBox(
    "PROMPT WB-01 · MULTI-SEGMENT SOCIAL CAMPAIGN (AGENCIES / FREELANCERS / TEAMS)",
    `Act as Dakyworld's Head of Product Growth using PROMPT WB-00.

TASK: Create a complete social campaign for Dakyworld Website Builder targeting one of our 3 core segments.
INPUT:
- TARGET SEGMENT: [SELECT: "Digital Agencies" OR "Freelancers" OR "Companies / In-House Marketing"]
- CORE TOPIC: [e.g. "Why Web Agencies Lose Margins on Client Handoffs" / "How In-House Marketing Teams Update Sites in 30 Seconds"]
- PLATFORMS: Instagram Carousel + Facebook Feed + LinkedIn Short Post

OUTPUT REQUIREMENTS:
1. 5-SLIDE INSTAGRAM/FACEBOOK CAROUSEL:
- Slide 1: Dark Navy (#08101F) cover with provocative, unhyped hook.
- Slide 2: The friction point (broken plugin, 2-week Jira ticket, or angry client message).
- Slide 3: The technical reality (why traditional CMS platforms fail).
- Slide 4: The Dakyworld solution (hybrid visual editor + developer GitHub workflow).
- Slide 5: Clean CTA directing to compare plans at dakyworld.com/pricing or DM keyword "BUILDER".
2. LINKEDIN B2B SHORT POST (140-180 words): Peer-to-peer register, workflow breakdown, pricing page link in first comment.
3. VISUAL ASSET DIRECTION: Specific UI layout notes for Figma/Canva.`
  );

  p.drawPromptBox(
    "PROMPT WB-02 · PRODUCT DEMO VIDEO SCRIPT (TIKTOK / REELS / YOUTUBE)",
    `Act as Dakyworld's Video Director using PROMPT WB-00.

TASK: Write a video script for Dakyworld Website Builder.
FORMAT: [SELECT: "30-45s Short Reel/TikTok" OR "3-5 Minute YouTube/Loom Walkthrough"]
TARGET BUYER: [Agencies / Freelancers / Companies]
SCENARIO TO DEMONSTRATE: [e.g. "Editing a live headline and replacing an image in 10 seconds" OR "Connecting WhatsApp ChatBridge to receive instant inquiries" OR "Reviewing a client edit via GitHub Pull Request"]

OUTPUT STRUCTURE:
1. Video Title & On-Screen Opening Hook (first 3 seconds).
2. Timecoded Action vs. Spoken Audio Table (0:00 to 0:45+).
3. Production Notes: Exact cursor focus, UI inspector zoom, and side-by-side comparisons.
4. Closing CTA directing viewers to test the sandbox and compare tiers on dakyworld.com/pricing.`
  );

  p.addNextPage();
  p.drawPromptBox(
    "PROMPT WB-03 · COLD OUTREACH TO AGENCY FOUNDERS & FREELANCERS",
    `Act as Dan Kwame Ayipah, Founder of Dakyworld, reaching out to an Agency Owner or Senior Freelance Developer.

TASK: Write a personalized 2-touch outreach sequence (Email + LinkedIn InMail).
PROSPECT DETAILS:
- Name & Title: [INSERT NAME, TITLE]
- Agency Name & Focus: [e.g. Acme Web Studio, Shopify & WordPress custom builds]
- Trigger Observation: [e.g. "Noticed their client portfolio sites rely heavily on multiple page builder plugins" OR "They offer ongoing monthly maintenance packages"]

RULES:
- Touch 1 (80-110 words): Zero sales pitch. Highlight the chronic agency bottleneck of client maintenance and plugin breakage. Ask if they have evaluated decoupled visual builders that let clients edit text without touching production code. Link softly to dakyworld.com/pricing for tier details.
- Touch 2 (Day 4 Follow-up, 40 words): Offer a brief 2-minute Loom link demonstrating the agency multi-site dashboard and GitHub PR workflow.`
  );

  p.drawSectionHeading("4. Agency & Freelancer Partner Onboarding Roadmap", "From free sandbox trial to high-margin recurring client management.");
  p.drawBullet("Step 1: Free Sandbox Trial", "Agencies test live visual editing and code inspection with zero barrier at dakyworld.com/pricing.");
  p.drawBullet("Step 2: Client Pilot Site", "Agency builds or migrates 1 client site to Dakyworld, testing client visual autonomy vs developer GitHub PR sync.");
  p.drawBullet("Step 3: Multi-Site Bulk Tier", "Agency migrates 5-20 clients onto Dakyworld Business tiers, capturing 80%+ margins on monthly care retainers.");

  for (const outPath of outPaths) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await p.finalize(outPath);
  }
}

// ==========================================
// MAIN RUNNER
// ==========================================
async function main() {
  console.log("Generating Global Marketing & Sales Plan PDF...");
  const planTarget = path.join(ROOT_DIR, "Dakyworld_90_Day_Global_Marketing_and_Sales_Plan.pdf");
  const planArtifact = path.join(BRAIN_DIR, "Dakyworld_90_Day_Global_Marketing_and_Sales_Plan.pdf");
  const p1 = new PdfBuilder("Global 90-Day Marketing & Sales Plan", "Dakyworld Revenue Engine");
  // Build and finalize to planTarget
  await buildGlobalMarketingSalesPlan([planTarget]);
  fs.copyFileSync(planTarget, planArtifact);

  console.log("Generating Website Builder Dedicated Product Playbook PDF...");
  const wbTarget = path.join(ROOT_DIR, "Dakyworld_Website_Builder_Product_Playbook.pdf");
  const wbArtifact = path.join(BRAIN_DIR, "Dakyworld_Website_Builder_Product_Playbook.pdf");
  await buildWebsiteBuilderPlaybook([wbTarget]);
  fs.copyFileSync(wbTarget, wbArtifact);

  console.log("Both PDFs successfully compiled and synchronized!");
}

main().catch((err) => {
  console.error("PDF generation failed:", err);
  process.exit(1);
});
