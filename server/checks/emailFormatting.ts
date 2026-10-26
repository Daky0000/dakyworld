/**
 * Verifies email body parsing, shortcodes ([highlight], [callout], [button], [badge], [code]),
 * raw HTML handling, markdown support, and email letterhead wrapping.
 *
 * No external API, no network, runs completely standalone.
 *   npx tsx checks/emailFormatting.ts
 */
import { formatEmailBodyToHtml, formatEmailBodyToText, parseShortcodeAttrs } from "../src/services/emailBodyParser.js";
import { toHtml, toText } from "../src/services/emailRender.js";

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

async function main() {
  console.log("checks/emailFormatting");

  // 1. Attribute parser
  const attrs = parseShortcodeAttrs('href="https://example.com" bg="#2563EB" align=center title=\'Note\' is_new');
  check("attribute parser extracts href", attrs.href === "https://example.com");
  check("attribute parser extracts bg", attrs.bg === "#2563EB");
  check("attribute parser extracts unquoted align", attrs.align === "center");
  check("attribute parser extracts single-quoted title", attrs.title === "Note");
  check("attribute parser defaults boolean flag to 'true'", attrs.is_new === "true");

  // 2. Plain text preservation
  const plain = "Hello John,\n\nHow is your project going?\n\nBest regards,\nDan";
  const plainHtml = formatEmailBodyToHtml(plain);
  check("plain text splits into <p> paragraphs", plainHtml.includes("<p style=\"margin:0 0 18px\">Hello John,</p>"));
  check("single newlines in paragraph convert to <br>", plainHtml.includes("Best regards,<br>Dan"));

  const plainText = formatEmailBodyToText(plain);
  check("plain text fallback intact", plainText.includes("Hello John,") && plainText.includes("Best regards,"));

  // 3. Shortcode: [highlight]
  const hl = "We observed [highlight]critical performance degradation[/highlight] on mobile.";
  const hlHtml = formatEmailBodyToHtml(hl);
  check("inline highlight renders <mark> with default yellow background", hlHtml.includes("<mark style=\"background-color:#FEF08A;color:#713F12;"));
  check("inline highlight preserves text", hlHtml.includes("critical performance degradation"));

  const hlCustom = "[highlight color=\"green\"]Site speed improved by 200%[/highlight]";
  const hlCustomHtml = formatEmailBodyToHtml(hlCustom);
  check("custom color highlight renders green background", hlCustomHtml.includes("<mark style=\"background-color:#DCFCE7;color:#166534;"));

  const hlText = formatEmailBodyToText(hl);
  check("highlight tags stripped from plain text fallback", !hlText.includes("[highlight]") && hlText.includes("critical performance degradation"));

  // 4. Shortcode: [callout] / [box] / [note]
  const callout = "[callout tone=\"warning\" title=\"Action Required\"]\nPlease update your billing contact.\n[/callout]";
  const calloutHtml = formatEmailBodyToHtml(callout);
  check("callout renders table with warning border", calloutHtml.includes("<table role=\"presentation\"") && calloutHtml.includes("border-left:4px solid #D97706"));
  check("callout renders title block", calloutHtml.includes("Action Required"));
  check("callout renders inner text", calloutHtml.includes("Please update your billing contact."));

  const calloutText = formatEmailBodyToText(callout);
  check("callout text fallback retains message", calloutText.includes("[NOTE: Please update your billing contact.]"));

  // 5. Shortcode: [button]
  const btn = "[button href=\"https://dakyx.com/portal\" bg=\"#2563EB\" align=\"center\"]Log in to Portal[/button]";
  const btnHtml = formatEmailBodyToHtml(btn);
  check("button renders presentation table", btnHtml.includes("<table role=\"presentation\""));
  check("button links to correct URL", btnHtml.includes("https://dakyx.com/portal"));
  check("button uses centered alignment", btnHtml.includes("margin-left:auto;margin-right:auto;"));
  check("button includes label text", btnHtml.includes("Log in to Portal"));

  const btnText = formatEmailBodyToText(btn);
  check("button text fallback shows label and url", btnText.includes("Log in to Portal (https://dakyx.com/portal)"));

  // 6. Shortcode: [badge]
  const badge = "Status: [badge tone=\"green\"]Active[/badge]";
  const badgeHtml = formatEmailBodyToHtml(badge);
  check("badge renders inline pill", badgeHtml.includes("<span style=\"display:inline-block;padding:2px 10px") && badgeHtml.includes("Active"));

  // 7. Raw HTML support
  const htmlInput = "Review your proposal: <a href=\"https://dakyx.com/p/1\" style=\"color:#2563EB;font-weight:bold;\">Proposal #101</a>\n\n<table border=\"1\"><tr><td>Item</td><td>Price</td></tr></table>";
  const htmlOutput = formatEmailBodyToHtml(htmlInput);
  check("raw <a> tag is NOT escaped into &lt;a", htmlOutput.includes("<a href=\"https://dakyx.com/p/1\" style=\"color:#2563EB;font-weight:bold;\">Proposal #101</a>"));
  check("raw <table> is NOT escaped", htmlOutput.includes("<table border=\"1\"><tr><td>Item</td><td>Price</td></tr></table>"));

  // 8. Sanitization of dangerous HTML
  const xss = "Hello <script>alert(1)</script><img src=\"x\" onerror=\"alert(2)\"><a href=\"javascript:void(0)\">Click</a>";
  const xssClean = formatEmailBodyToHtml(xss);
  check("script tag is completely stripped", !xssClean.includes("<script") && !xssClean.includes("alert(1)"));
  check("onerror attribute is stripped", !xssClean.includes("onerror"));
  check("javascript: href is defanged", !xssClean.includes("javascript:"));

  // 9. Markdown formatting
  const md = "Here is **bold** text and *italic* text and ~~struck~~ text.\n\n- Feature 1\n- Feature 2";
  const mdHtml = formatEmailBodyToHtml(md);
  check("markdown **bold** rendered as <strong>", mdHtml.includes("<strong>bold</strong>"));
  check("markdown *italic* rendered as <em>", mdHtml.includes("<em>italic</em>"));
  check("markdown ~~struck~~ rendered as <s>", mdHtml.includes("<s>struck</s>"));
  check("markdown list rendered as <ul><li>", mdHtml.includes("<ul style=") && mdHtml.includes("<li style="));

  // 10. Code blocks and inline code
  const codeInput = "Run `npm install` then:\n```bash\nnpm run start\n```";
  const codeHtml = formatEmailBodyToHtml(codeInput);
  check("inline code rendered as <code>", codeHtml.includes("<code style=\"background-color:#F1F5F9;"));
  check("code block rendered as <pre><code>", codeHtml.includes("<pre style=\"background-color:#0F172A;") && codeHtml.includes("npm run start"));

  // 11. Full toHtml / toText integration with letterhead
  const renderedHtml = toHtml("Hello\n\n[highlight]Notice[/highlight]\n\n[button href=\"https://dakyx.com\"]Visit[/button]", "Dan Kwame Ayipah", null);
  check("toHtml wraps inside full email letterhead table", renderedHtml.includes("<table role=\"presentation\""));
  check("toHtml retains highlight", renderedHtml.includes("<mark style=\"background-color:#FEF08A;"));
  check("toHtml retains button", renderedHtml.includes("Visit"));

  const renderedText = toText("Hello\n\n[highlight]Notice[/highlight]\n\n[button href=\"https://dakyx.com\"]Visit[/button]", "Dan Kwame Ayipah", null);
  check("toText produces plain text without markup", renderedText.includes("Notice") && !renderedText.includes("[highlight]"));
  check("toText produces button link", renderedText.includes("Visit (https://dakyx.com)"));

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
