import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const OUTPUT_PATHS = [
  "c:/Users/ASUS/Pictures/Dakyworld/WhatsApp_ChatBridge_CRM_Addon_Guide.pdf",
  "c:/Users/ASUS/Pictures/Dakyworld/repo/server/WhatsApp_ChatBridge_CRM_Addon_Guide.pdf",
  "C:/Users/ASUS/.gemini/antigravity/brain/28cbf6e8-310f-472b-8f7a-73cae7d9106f/WhatsApp_ChatBridge_CRM_Addon_Guide.pdf",
];

function generatePdf(targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const doc = new PDFDocument({
      size: "A4",
      margin: 36,
      info: {
        Title: "DakyXTech Website Builder — WhatsApp ChatBridge CRM Add-on Guide",
        Author: "DakyXTech OS",
        Subject: "$5/mo (GHS 75/mo) WhatsApp Lead Generation & Real-time Inquiries Engine",
      },
    });

    const stream = fs.createWriteStream(targetPath);
    doc.pipe(stream);

    const pageWidth = doc.page.width; // 595.28
    const pageHeight = doc.page.height; // 841.89
    const contentWidth = pageWidth - 72; // 523.28

    // ==================== PAGE 1 ====================
    // Header Banner
    doc.rect(0, 0, pageWidth, 110).fill("#071224");
    doc.rect(0, 106, pageWidth, 4).fill("#25D366"); // WhatsApp Emerald accent

    doc
      .fillColor("#25D366")
      .font("Helvetica-Bold")
      .fontSize(9)
      .text("DAKYXTECH OS • MODULAR WEBSITE BUILDER ADD-ON SPECIFICATION", 36, 24, {
        characterSpacing: 1.1,
      });

    doc
      .fillColor("#FFFFFF")
      .font("Helvetica-Bold")
      .fontSize(21)
      .text("WhatsApp ChatBridge CRM Add-on", 36, 40);

    doc
      .fillColor("#94A3B8")
      .font("Helvetica")
      .fontSize(9.5)
      .text(
        "Direct-to-WhatsApp Lead Generation, Smart Pre-Filled Prompts, Business Hours & Offline Inquiries CRM",
        36,
        68,
      );

    doc
      .fillColor("#B8FF3D")
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Pricing: $5.00 / month  |  GHS 75.00 / month (Paystack Recurring)", 36, 86);

    let y = 126;

    // Executive Value Summary Callout
    doc.roundedRect(36, y, contentWidth, 54, 6).fillAndStroke("#F0FDF4", "#86EFAC");
    doc
      .fillColor("#14532D")
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Why It Converts: Solving the 85% Mobile Conversion Drop-off", 48, y + 10);
    doc
      .fillColor("#166534")
      .font("Helvetica")
      .fontSize(8.5)
      .text(
        "In emerging & mobile-first economies, over 85% of purchases and bookings close on WhatsApp. Traditional email forms are ignored. ChatBridge turns any DakyXTech site into an active conversational funnel: daytime visitors connect with pre-filled intent, while nighttime visitors are captured into a dedicated CRM inbox.",
        48,
        y + 24,
        { width: contentWidth - 24, lineGap: 1.8 },
      );

    y += 66;

    // Section 1: The 4 Core Capabilities
    doc
      .fillColor("#0F172A")
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("Four Pillars of WhatsApp ChatBridge CRM", 36, y);

    y += 18;

    const pillars = [
      {
        num: "01",
        title: "Context-Aware Pre-Filled Prompts (Business Hours)",
        desc: "Instead of dropping visitors into an empty chat, the widget suggests 2-3 page-specific prompts (e.g. 'Inquiring about Dental Implants' on /treatments). One tap launches WhatsApp Web or mobile app via wa.me with the prompt pre-typed.",
        accent: "#059669",
        bg: "#ECFDF5",
        border: "#A7F3D0",
      },
      {
        num: "02",
        title: "Never-Lose-A-Lead Offline Form (After Hours & Weekends)",
        desc: "When visitors arrive outside configured hours, the widget gracefully switches to an offline lead catcher. Prospects submit their Name, WhatsApp number, and question, setting clear expectations of an early-morning response.",
        accent: "#0284C7",
        bg: "#F0F9FF",
        border: "#BAE6FD",
      },
      {
        num: "03",
        title: "Instant Zero-Friction Owner Alert & 1-Tap Reply Loop",
        desc: "The moment an offline inquiry lands, DakyXTech sends an SMS/WhatsApp alert to the owner's phone with a 1-tap waLink. The business owner taps the link and is instantly chatting with the lead on WhatsApp—no dashboard login required.",
        accent: "#D97706",
        bg: "#FFFBEB",
        border: "#FDE68A",
      },
      {
        num: "04",
        title: "Inquiries CRM Dashboard & PDF Billing Action",
        desc: "Inside DakyXTech, owners access a live pipeline of all inquiries with lead status (New, Contacted, Won), page origin, and a 1-click 'Send PDF Invoice' button that links directly to DakyXTech's automated invoice generator.",
        accent: "#7C3AED",
        bg: "#F5F3FF",
        border: "#DDD6FE",
      },
    ];

    for (const p of pillars) {
      const boxH = 50;
      doc.roundedRect(36, y, contentWidth, boxH, 6).fillAndStroke(p.bg, p.border);
      
      // Number badge
      doc.roundedRect(44, y + 8, 24, 20, 4).fill(p.accent);
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9).text(p.num, 48, y + 13);

      doc.fillColor("#0F172A").font("Helvetica-Bold").fontSize(9.5).text(p.title, 76, y + 10);
      doc.fillColor("#334155").font("Helvetica").fontSize(8).text(p.desc, 76, y + 23, {
        width: contentWidth - 88,
        lineGap: 1.5,
      });

      y += boxH + 8;
    }

    y += 6;

    // Technical & Architecture Callout Box
    doc.roundedRect(36, y, contentWidth, 74, 6).fillAndStroke("#F8FAFC", "#E2E8F0");
    doc.fillColor("#0F172A").font("Helvetica-Bold").fontSize(9.5).text("Zero-Bloat Technical Architecture", 48, y + 8);
    
    const techPoints = [
      "• Lightweight Embed Script: Pure 3.8 KB vanilla JS (<0.05s load), 0 external dependencies, preserves 100/100 PageSpeed.",
      "• Reuses DakyXTech Core: E.164 phone parser & waLink in lib/phone.ts, honeypot botCheck.ts, and messageSender.ts.",
      "• Data Privacy & Deliverability: Click-to-chat requires no Meta Business verification or per-conversation messaging fees.",
    ];
    let ty = y + 24;
    for (const tp of techPoints) {
      doc.fillColor("#475569").font("Helvetica").fontSize(8).text(tp, 48, ty, { width: contentWidth - 24 });
      ty += 14;
    }

    // Footer Page 1
    doc.fillColor("#94A3B8").font("Helvetica").fontSize(7.5).text(
      "DakyXTech OS • Website Builder Add-on Documentation • WhatsApp ChatBridge CRM ($5/mo / GHS 75/mo)",
      36,
      pageHeight - 26,
    );

    // ==================== PAGE 2 ====================
    doc.addPage();

    // Dark Header Page 2
    doc.rect(0, 0, pageWidth, 56).fill("#071224");
    doc.rect(0, 52, pageWidth, 4).fill("#25D366");
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(13).text("WhatsApp ChatBridge CRM — Economics, Workflow & Setup", 36, 20);

    let y2 = 72;

    // Monetization & Financial Unit Economics
    doc.fillColor("#0F172A").font("Helvetica-Bold").fontSize(11).text("1. Monetization & Unit Economics (GHS 75 / $5 Monthly)", 36, y2);
    y2 += 16;

    const econTable = [
      ["Metric", "Value", "Strategic Impact"],
      ["Monthly Add-on Price", "$5.00 / GHS 75.00", "Micro-SaaS impulse pricing, easily paid via Paystack MoMo or Card"],
      ["Annual Pre-pay Option", "$50.00 / GHS 750.00", "2 months free; locks in 12-month retention and upfront cashflow"],
      ["Estimated Monthly COGS", "~$0.25 (SMS alerts)", "95% gross profit margin per active subscriber"],
      ["Included Notification Quota", "100 Owner SMS Alerts", "Sufficient for 98% of SMBs; top-up pack GHS 25 for 200 SMS"],
      ["Client ROI Justification", "1 closed deal in 3 months", "Single customer booking typically yields GHS 500 - GHS 5,000+"],
    ];

    const colWidths = [120, 110, contentWidth - 230];
    for (let r = 0; r < econTable.length; r++) {
      const isHeader = r === 0;
      const row = econTable[r];
      const rh = 18;
      
      if (isHeader) {
        doc.rect(36, y2, contentWidth, rh).fill("#0F172A");
      } else {
        doc.rect(36, y2, contentWidth, rh).fill(r % 2 === 1 ? "#F8FAFC" : "#FFFFFF");
        doc.rect(36, y2, contentWidth, rh).stroke("#E2E8F0");
      }

      let cx = 44;
      for (let c = 0; c < row.length; c++) {
        doc
          .fillColor(isHeader ? "#FFFFFF" : c === 1 ? "#059669" : "#1E293B")
          .font(isHeader ? "Helvetica-Bold" : c === 0 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(7.8)
          .text(row[c], cx, y2 + 5, { width: colWidths[c] - 10 });
        cx += colWidths[c];
      }
      y2 += rh;
    }

    y2 += 16;

    // Workflow Comparison Box
    doc.fillColor("#0F172A").font("Helvetica-Bold").fontSize(11).text("2. Traditional Static Website vs. DakyXTech ChatBridge Flow", 36, y2);
    y2 += 16;

    const compareHeight = 92;
    // Left: Old Way
    doc.roundedRect(36, y2, (contentWidth - 12) / 2, compareHeight, 6).fillAndStroke("#FEF2F2", "#FECACA");
    doc.fillColor("#991B1B").font("Helvetica-Bold").fontSize(9).text("The Old Way (Static Form / Empty Chat)", 46, y2 + 10);
    const oldSteps = [
      "• Visitor fills 5-field contact form or clicks blank wa.me",
      "• Inquiry sits unread in info@ email spam folder for 3 days",
      "• After-hours visitors bounce immediately to a competitor",
      "• Business owner has zero record of website visitor inquiries",
    ];
    let sy = y2 + 26;
    for (const s of oldSteps) {
      doc.fillColor("#7F1D1D").font("Helvetica").fontSize(7.5).text(s, 46, sy, { width: (contentWidth - 32) / 2 });
      sy += 15;
    }

    // Right: DakyXTech ChatBridge Way
    const rx = 36 + (contentWidth - 12) / 2 + 12;
    doc.roundedRect(rx, y2, (contentWidth - 12) / 2, compareHeight, 6).fillAndStroke("#F0FDF4", "#BBF7D0");
    doc.fillColor("#166534").font("Helvetica-Bold").fontSize(9).text("The DakyXTech ChatBridge Way", rx + 10, y2 + 10);
    const newSteps = [
      "• One-tap contextual prompt matches exact page viewed",
      "• Nighttime visitors captured via automated offline form",
      "• Owner receives instant SMS alert with 1-tap waLink",
      "• Real-time DakyXTech CRM tracks leads & one-click PDF invoices",
    ];
    let sy2 = y2 + 26;
    for (const s of newSteps) {
      doc.fillColor("#14532D").font("Helvetica").fontSize(7.5).text(s, rx + 10, sy2, { width: (contentWidth - 32) / 2 });
      sy2 += 15;
    }

    y2 += compareHeight + 16;

    // Section 3: Builder Configuration Controls
    doc.fillColor("#0F172A").font("Helvetica-Bold").fontSize(11).text("3. In-Editor Configuration Panel (What the Creator Controls)", 36, y2);
    y2 += 16;

    doc.roundedRect(36, y2, contentWidth, 80, 6).fillAndStroke("#F8FAFC", "#CBD5E1");
    const configItems = [
      ["WhatsApp Number:", "Local or international mobile number; validated with E.164 (+233 24 123 4567)."],
      ["Agent Persona:", "Custom Support Name (e.g. 'Kwame / Client Concierge') + uploaded brand avatar photo."],
      ["Working Schedule:", "Visual Day/Time matrix (Mon-Sat 8:00 AM - 6:00 PM) for automatic online/offline switching."],
      ["Context Prompts:", "Custom prompt rules: e.g. /pricing -> 'I have a question about your pricing plans'."],
      ["SMS Alert Target:", "Owner's phone number where high-priority new-lead alerts are instantly delivered."],
    ];

    let cy = y2 + 8;
    for (const [k, v] of configItems) {
      doc.fillColor("#0F172A").font("Helvetica-Bold").fontSize(8).text(k, 48, cy, { width: 100 });
      doc.fillColor("#334155").font("Helvetica").fontSize(8).text(v, 150, cy, { width: contentWidth - 120 });
      cy += 14;
    }

    // Footer Page 2
    doc.fillColor("#94A3B8").font("Helvetica").fontSize(7.5).text(
      "DakyXTech OS • Website Builder Add-on Documentation • Generated September 2026",
      36,
      pageHeight - 26,
    );

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function main() {
  for (const p of OUTPUT_PATHS) {
    await generatePdf(p);
    console.log(`Generated PDF at: ${p}`);
  }
}

main().catch(console.error);
