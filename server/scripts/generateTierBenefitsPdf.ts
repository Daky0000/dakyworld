import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const OUTPUT_PATHS = [
  "c:/Users/ASUS/Pictures/Dakyworld/Dakyworld_Website_Builder_Tier_Plans_and_Benefits.pdf",
  "c:/Users/ASUS/Pictures/Dakyworld/Dakyworld OS/server/Dakyworld_Website_Builder_Tier_Plans_and_Benefits.pdf",
  "C:/Users/ASUS/.gemini/antigravity/brain/a64092c1-c572-45f3-9125-b32afff8ac57/Dakyworld_Website_Builder_Tier_Plans_and_Benefits.pdf",
];

function generatePdf(targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const doc = new PDFDocument({
      size: "A4",
      margin: 36,
      info: {
        Title: "Dakyworld Website Builder — Tier Plans & Benefits Guide",
        Author: "Dakyworld OS",
        Subject: "Starter $3 ($5), Pro $10 ($16), and Business $25 ($45) Tier Plans, Storage Quotas & Feature Benefits",
      },
    });

    const stream = fs.createWriteStream(targetPath);
    doc.pipe(stream);

    const pageWidth = doc.page.width; // 595.28
    const contentWidth = pageWidth - 72; // 523.28

    // ==================== PAGE 1 ====================
    // Dark Navy Header Banner
    doc.rect(0, 0, pageWidth, 108).fill("#08101F");
    doc.rect(0, 104, pageWidth, 4).fill("#B8FF3D");

    doc
      .fillColor("#B8FF3D")
      .font("Helvetica-Bold")
      .fontSize(9)
      .text("DAKYWORLD OS • WEBSITE BUILDER & MEDIA LIBRARY STORAGE SYSTEM", 36, 24, {
        characterSpacing: 1.1,
      });

    doc
      .fillColor("#F4F5F0")
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("Website Tier Plans & Complete Benefits Guide", 36, 40);

    doc
      .fillColor("#CBD5E1")
      .font("Helvetica")
      .fontSize(10)
      .text(
        "Three Subscription Tiers: Starter $3 ($5) • Pro $10 ($16) • Business $25 ($45)  |  Automatic 3-Month Standard Price Reversion",
        36,
        68,
      );

    let y = 122;

    // Billing Rule Callout Box
    doc.roundedRect(36, y, contentWidth, 50, 6).fillAndStroke("#F0FDF4", "#86EFAC");
    doc
      .fillColor("#14532D")
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("3-Month Promotional Pricing & Automatic Standard Price Reversion Policy", 48, y + 10);
    doc
      .fillColor("#166534")
      .font("Helvetica")
      .fontSize(8.8)
      .text(
        "Every new subscriber enjoys the promotional rate ($3/mo, $10/mo, or $25/mo) for their first 3 months. Upon completing month 3 (day 90+), the billing engine automatically reverts the subscription to the standard monthly rate in brackets ($5/mo, $16/mo, or $45/mo).",
        48,
        y + 24,
        { width: contentWidth - 24, lineGap: 2 },
      );

    y += 62;

    // 3 Tier Detailed Benefit Cards (Stacked cleanly with rich columns)
    const tiers = [
      {
        badge: "TIER 1 • STARTER",
        name: "Starter Plan (EDITOR)",
        priceDisplay: "$3 ($5) / month",
        promoText: "$3.00/mo for Months 1–3  ->  Reverts to $5.00/mo Standard in Month 4+",
        accentColor: "#0284C7",
        bgTint: "#F0F9FF",
        borderTint: "#BAE6FD",
        storage: "50 MB Per-User Media Library Storage (Max 2 MB per single image upload)",
        quotas: "3 HTML Imports / month  •  30 Page Edits & Saves / month  •  1 Website  •  Up to 2 Team Members",
        benefits: [
          "Full Visual Drag-and-Drop & Click-to-Edit Page Builder with Live Responsive Preview (Desktop, Tablet, Mobile)",
          "Floating & Draggable Elementor-style Structure / Layers Panel for inspecting and reordering page sections",
          "Dedicated Container Inspector: Layout Tab (Flex/Grid, Align, Justify, Gap, Size) & Style Tab (Spacing, Position)",
          "50 MB Per-User Media Library Storage with automatic capture of all HTML <img> & CSS background-image URLs",
          "Modernized Color Picker + #HEX Code inputs across all element style properties with live canvas preview",
          "Up to 3 HTML page imports/month and 30 page draft saves/month",
        ],
        locked:
          "Global Theme Color Palette Tab • SEO Inspector & Alt-Text Auto-Fixer • AI Assistant • AI Builder Agent • Source Code Editor • GitHub PR Workflow",
      },
      {
        badge: "TIER 2 • PRO (MOST POPULAR)",
        name: "Pro Care Plan (CARE)",
        priceDisplay: "$10 ($16) / month",
        promoText: "$10.00/mo for Months 1–3  ->  Reverts to $16.00/mo Standard in Month 4+",
        accentColor: "#15803D",
        bgTint: "#F0FDF4",
        borderTint: "#86EFAC",
        storage: "500 MB Per-User Media Library Storage (Max 5 MB per single image upload — 10x Starter Storage)",
        quotas: "15 HTML Imports / mo  •  200 Page Edits / mo  •  50 AI Prompts / mo  •  3 Websites  •  Up to 5 Team Members",
        benefits: [
          "Everything in Starter, plus 500 MB Per-User Media Library Storage (up to 5 MB per high-res image upload)",
          "UNLOCKED: Global Page Theme Tab — edit CSS variables & page-wide #HEX color tokens across the whole page",
          "UNLOCKED: One-Click Brand Style Presets & Global Surface / Typography Controls",
          "UNLOCKED: Full SEO Inspector, Search Preview & Bulk Image Alt-Text Auto-Fixer + Printable Client SEO Report",
          "UNLOCKED: AI Copywriting & Layout Assistant (up to 50 AI prompts/month for rewriting headlines & sections)",
          "Priority Support + 60 Technical Care Minutes/month + Automated Uptime & Broken-Link Monitoring",
        ],
        locked:
          "Autonomous AI Builder Agent (Full-Section Generation) • Raw HTML/CSS/TSX Source Code Editor • GitHub Pull Request Review Workflow",
      },
      {
        badge: "TIER 3 • BUSINESS (ALL-INCLUSIVE)",
        name: "Business Managed Plan (MANAGED)",
        priceDisplay: "$25 ($45) / month",
        promoText: "$25.00/mo for Months 1–3  ->  Reverts to $45.00/mo Standard in Month 4+",
        accentColor: "#7E22CE",
        bgTint: "#FAF5FF",
        borderTint: "#D8B4FE",
        storage: "5 GB Per-User Media Library Storage (Max 10 MB per single image upload — 100x Starter Storage)",
        quotas: "UNLIMITED HTML Imports  •  UNLIMITED Page Edits  •  UNLIMITED AI Prompts  •  10 Websites  •  15 Team Users",
        benefits: [
          "Everything in Pro, plus 5 GB Per-User Media Library Storage (up to 10 MB per asset) & Unlimited Monthly Usage",
          "UNLOCKED: Autonomous AI Builder Agent — conversational AI that builds & styles entire multi-block page sections",
          "UNLOCKED: Raw Source Code Editor — direct HTML / CSS / Astro / React source editing with diff verification",
          "UNLOCKED: GitHub Pull Request Publishing Workflow — publish via reviewed GitHub PRs or direct commits",
          "UNLOCKED: Unlimited HTML Page Imports, Unlimited Page Edits/Saves & Unlimited AI Assistant / Builder Agent Runs",
          "Highest-Priority Concierge Support + 240 Technical Hours (4 hrs/mo) + Monthly Conversion & Performance Reviews",
        ],
        locked: "None — 100% of Dakyworld Website Builder, Media Library, AI & Developer features are unlocked.",
      },
    ];

    for (const tier of tiers) {
      const cardHeight = 198;
      doc.roundedRect(36, y, contentWidth, cardHeight, 7).fillAndStroke(tier.bgTint, tier.borderTint);

      // Top bar inside card
      doc.roundedRect(36, y, contentWidth, 26, 7).fill(tier.accentColor);
      doc
        .fillColor("#FFFFFF")
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .text(`${tier.badge}  —  ${tier.name}`, 48, y + 8);
      doc
        .fillColor("#FFFFFF")
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(tier.priceDisplay, 36, y + 7, { width: contentWidth - 12, align: "right" });

      // Subheader pricing reversion
      doc
        .fillColor("#0F172A")
        .font("Helvetica-Bold")
        .fontSize(8.5)
        .text(`Billing Schedule: ${tier.promoText}`, 48, y + 32);

      doc
        .fillColor("#1E293B")
        .font("Helvetica-Bold")
        .fontSize(8.3)
        .text(`Media Storage: `, 48, y + 45, { continued: true })
        .font("Helvetica")
        .text(tier.storage);

      doc
        .fillColor("#1E293B")
        .font("Helvetica-Bold")
        .fontSize(8.3)
        .text(`Monthly Quotas: `, 48, y + 57, { continued: true })
        .font("Helvetica")
        .text(tier.quotas);

      // Benefits list
      let by = y + 72;
      doc.fillColor("#0F172A").font("Helvetica-Bold").fontSize(8.3).text("Included Benefits & Capabilities:", 48, by);
      by += 11;
      for (const b of tier.benefits) {
        doc
          .fillColor("#1E293B")
          .font("Helvetica")
          .fontSize(7.9)
          .text(`•  ${b}`, 52, by, { width: contentWidth - 28, lineGap: 0.5 });
        by += 14.5;
      }

      // Locked line
      doc
        .fillColor(tier.locked.startsWith("None") ? "#15803D" : "#B91C1C")
        .font("Helvetica-Bold")
        .fontSize(7.8)
        .text(`Restrictions: ${tier.locked}`, 48, y + cardHeight - 17, {
          width: contentWidth - 24,
        });

      y += cardHeight + 12;
    }

    // ==================== PAGE 2: COMPARISON TABLE & TEST USERS ====================
    doc.addPage();

    doc.rect(0, 0, pageWidth, 68).fill("#08101F");
    doc.rect(0, 65, pageWidth, 3).fill("#B8FF3D");
    doc
      .fillColor("#B8FF3D")
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .text("SIDE-BY-SIDE CAPABILITY MATRIX & TEST ACCOUNTS", 36, 18, { characterSpacing: 1 });
    doc
      .fillColor("#F4F5F0")
      .font("Helvetica-Bold")
      .fontSize(16)
      .text("Feature Comparison Matrix & Subscribed Test Users", 36, 33);

    let y2 = 84;

    const colWidths = [203, 106, 106, 108]; // sum = 523
    const colX = [36, 239, 345, 451];

    // Table Header
    doc.roundedRect(36, y2, contentWidth, 26, 4).fill("#0F172A");
    const headers = [
      "Feature / Quota / Benefit",
      "Starter  $3 ($5)",
      "Pro  $10 ($16)",
      "Business  $25 ($45)",
    ];
    headers.forEach((h, i) => {
      doc
        .fillColor(i === 0 ? "#F8FAFC" : "#B8FF3D")
        .font("Helvetica-Bold")
        .fontSize(8.5)
        .text(h, colX[i]! + 6, y2 + 8, { width: colWidths[i]! - 12, align: i === 0 ? "left" : "center" });
    });
    y2 += 26;

    const rows: Array<[string, string, string, string]> = [
      ["Months 1–3 Promotional Price", "$3.00 / month", "$10.00 / month", "$25.00 / month"],
      ["Month 4+ Standard Price (Auto-Reverts)", "$5.00 / month", "$16.00 / month", "$45.00 / month"],
      ["Per-User Media Library Storage Quota", "50 MB", "500 MB", "5 GB (5,120 MB)"],
      ["Max Single Image Upload Size", "2 MB / file", "5 MB / file", "10 MB / file"],
      ["Auto-Capture HTML Images on Import", "Included", "Included", "Included"],
      ["Monthly HTML Page Imports", "3 imports / mo", "15 imports / mo", "Unlimited"],
      ["Monthly Page Edits & Draft Saves", "30 edits / mo", "200 edits / mo", "Unlimited"],
      ["Monthly AI Assistant Prompts", "Locked (0)", "50 prompts / mo", "Unlimited"],
      ["Websites Included", "1 Website", "3 Websites", "10 Websites"],
      ["Team Member Seats", "Up to 2 Users", "Up to 5 Users", "Up to 15 Users"],
      ["Visual Editor & Floating Layers Tree", "Included", "Included", "Included"],
      ["Container Layout & Style Inspector", "Included", "Included", "Included"],
      ["Modern Color Picker + #HEX Input", "Included", "Included", "Included"],
      ["Global Page Theme Color Palette Tab", "Locked", "Included", "Included"],
      ["Brand Style Presets & Surface Controls", "Locked", "Included", "Included"],
      ["SEO Inspector & Alt-Text Auto-Fixer", "Locked", "Included", "Included"],
      ["AI Copywriting & Layout Assistant", "Locked", "Included (50/mo)", "Included (Unlimited)"],
      ["Autonomous AI Builder Agent", "Locked", "Locked", "Included"],
      ["Raw HTML / Source Code Editor", "Locked", "Locked", "Included"],
      ["GitHub Pull Request Publish Workflow", "Locked", "Locked", "Included"],
      ["Included Monthly Technical Care Time", "None", "60 mins / month", "240 mins (4 hrs) / mo"],
      ["Support Priority & Reviews", "Standard", "Priority + Monitoring", "Highest + Monthly Review"],
    ];

    rows.forEach((row, idx) => {
      const rh = 19.5;
      const bg = idx % 2 === 0 ? "#F8FAFC" : "#FFFFFF";
      doc.rect(36, y2, contentWidth, rh).fillAndStroke(bg, "#E2E8F0");

      row.forEach((cell, cIdx) => {
        const isLocked = cell.startsWith("Locked");
        const isHighlight =
          cell.startsWith("Included") || cell.startsWith("Unlimited") || cell.includes("GB") || cell.includes("500 MB");
        doc
          .fillColor(
            cIdx === 0
              ? "#0F172A"
              : isLocked
                ? "#DC2626"
                : isHighlight
                  ? "#15803D"
                  : "#1E293B",
          )
          .font(cIdx === 0 || isHighlight ? "Helvetica-Bold" : "Helvetica")
          .fontSize(8)
          .text(cell, colX[cIdx]! + 6, y2 + 5.5, {
            width: colWidths[cIdx]! - 12,
            align: cIdx === 0 ? "left" : "center",
          });
      });

      y2 += rh;
    });

    y2 += 16;

    // Subscribed Test Accounts Box
    doc.roundedRect(36, y2, contentWidth, 132, 7).fillAndStroke("#08101F", "#334155");
    doc
      .fillColor("#B8FF3D")
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Pre-Configured Subscribed Test Users (Ready for Immediate Login & 1-Click UI Switching)", 48, y2 + 11);

    doc
      .fillColor("#CBD5E1")
      .font("Helvetica")
      .fontSize(8.2)
      .text(
        "Use these 3 accounts at /login or via the 1-Click 'Switch Test User / Tier Plan' bar inside the Website Editor & Media Library:",
        48,
        y2 + 25,
      );

    const testAccounts = [
      [
        "Starter Tier ($3 ($5)/mo)",
        "starter@dakyworld.test",
        "Starter#2026!",
        "Ama Mensah (Accra Bloom Studio)",
        "50 MB Storage • 3 Imports/mo • 30 Edits/mo",
      ],
      [
        "Pro Tier ($10 ($16)/mo)",
        "pro@dakyworld.test",
        "ProTier#2026!",
        "Kofi Owusu (Kumasi Craft Collective)",
        "500 MB Storage • 15 Imports/mo • Theme & SEO Unlocked",
      ],
      [
        "Business Tier ($25 ($45)/mo)",
        "business@dakyworld.test",
        "Business#2026!",
        "Esi Asante (Atlantic Horizon Group)",
        "5 GB Storage • Unlimited Imports/Edits • All AI & Source Unlocked",
      ],
    ];

    let ty = y2 + 44;
    for (const acc of testAccounts) {
      doc.roundedRect(48, ty, contentWidth - 24, 24, 4).fill("#1E293B");
      doc
        .fillColor("#B8FF3D")
        .font("Helvetica-Bold")
        .fontSize(8.2)
        .text(acc[0]!, 56, ty + 4);
      doc
        .fillColor("#FFFFFF")
        .font("Helvetica-Bold")
        .fontSize(8.2)
        .text(`Email: ${acc[1]}   |   Password: ${acc[2]}`, 175, ty + 4);
      doc
        .fillColor("#94A3B8")
        .font("Helvetica")
        .fontSize(7.6)
        .text(`${acc[3]}  —  ${acc[4]}`, 56, ty + 14);
      ty += 28;
    }

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

async function main() {
  for (const out of OUTPUT_PATHS) {
    await generatePdf(out);
    console.log(`Generated PDF: ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
