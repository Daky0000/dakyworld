/**
 * Where we got somebody's details, told to them on the first message.
 *
 * Article 13 GDPR covers data a person hands you. **Article 14 covers data you
 * got some other way**, and it is the one that governs everything this pipeline
 * does — a business scraped off Google Maps, an address read off a homepage, a
 * company found in a directory. It asks for more than Art 13, not less,
 * precisely because the person had no idea it was happening.
 *
 * One item on its list has no equivalent anywhere else in the regulation:
 * **Art 14(2)(f), the source the data came from**. Everything else — who we
 * are, why, on what basis, for how long, what rights — can live in the privacy
 * policy and be linked to, which Art 14(3)(a) permits. The source cannot,
 * because it differs per person: "we found your business on Google Maps" is a
 * fact about them, not about us, and no policy page can say it.
 *
 * And Art 14(3)(b) sets the deadline at **the first communication**. So this
 * cannot be a thing somebody remembers, or a thing a model is asked to include
 * — it is either on every first message or the obligation is missed on
 * whichever one it was left off. It is appended by code for exactly the reason
 * the opt-out sentence is.
 *
 * Half of this file is the negatives, and they are the half worth reading. A
 * notice that appears on a client's invoice covering note is telling somebody
 * we found their details somewhere when they are a customer of two years. A
 * notice that names Google Maps for a lead nobody recorded a source for is a
 * false statement to the one person alive who can check it. Both are worse
 * than the omission this fixes.
 *
 * Database only. No API key, no network.
 *   npx tsx checks/sourceNotice.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { composeMessage } from "../src/services/emailSender.js";
import { composeMessage as composePhoneMessage } from "../src/services/messageSender.js";
import { renderEmail } from "../src/services/emailRender.js";
import { namesASource, shortSourceNotice, sourceNotice, sourcePhrase } from "../src/services/dataSourceNotice.js";
import type { LeadSource } from "@prisma/client";

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

/** Everything this run makes carries the mark, so cleanup cannot touch real data. */
const MARK = "sourcenoticecheck";

/** Stored without the +, as MessageThread.phone is. */
const PHONES = ["233200000111", "233200000222"];

async function reset() {
  await prisma.emailMessage.deleteMany({ where: { toEmail: { contains: MARK } } });
  await prisma.lead.deleteMany({ where: { contactName: { contains: MARK } } });
  await prisma.client.deleteMany({ where: { name: { contains: MARK } } });
  await prisma.message.deleteMany({ where: { toPhone: { in: PHONES } } });
  await prisma.messageThread.deleteMany({ where: { phone: { in: PHONES } } });
}

async function main() {
  await reset();

  // --- the sentence itself ---------------------------------------------------

  check(
    "a scraped listing is named in the business's own words",
    sourcePhrase("GOOGLE_MAPS").includes("Google Business listing"),
    sourcePhrase("GOOGLE_MAPS"),
  );
  check("a website sweep says so", sourcePhrase("WEB_SCRAPE").includes("your own website"));

  // The negative that matters most in this file. OTHER, COLD_EMAIL and OUTREACH
  // describe our own pipeline rather than a place anything was found, so none of
  // them can answer "where did you get this" — and inventing an answer would be
  // a false statement to the one person who can check it.
  for (const vague of ["OTHER", "COLD_EMAIL", "OUTREACH"] as LeadSource[]) {
    check(`${vague} names no specific source`, !namesASource(vague));
    check(
      `${vague} still gets an honest general phrase`,
      sourcePhrase(vague) === "publicly available business listings" && !sourcePhrase(vague).includes("Google"),
      sourcePhrase(vague),
    );
  }
  check("an unrecorded source is handled like a vague one", sourcePhrase(null) === sourcePhrase("OTHER"));

  const notice = sourceNotice({
    source: "GOOGLE_MAPS",
    privacyUrl: "https://dakyworld.com/privacy",
    companyName: "Dakyworld",
    privacyEmail: "privacy@dakyworld.com",
  });
  check("the notice states the legal basis", notice.text.includes("legitimate interest"));
  check("the notice points at the policy", notice.text.includes("https://dakyworld.com/privacy"));
  check("the notice gives an address to write to", notice.text.includes("privacy@dakyworld.com"));
  check("the HTML form links the policy", notice.html.includes('<a href="https://dakyworld.com/privacy"'));
  check("the HTML form escapes the sentence", !notice.html.includes("<script"));

  // A site with no website on file must still produce a usable notice, because
  // "we could not build a link" is not a reason to tell somebody nothing.
  const linkless = sourceNotice({
    source: "DIRECTORY",
    privacyUrl: null,
    companyName: "Dakyworld",
    privacyEmail: "privacy@dakyworld.com",
  });
  check("with no policy URL it still says how to reach us", linkless.text.includes("privacy@dakyworld.com"));
  check("and does not print a broken link", !linkless.html.includes("href=\"null\""));

  // --- a real cold email -----------------------------------------------------

  const lead = await prisma.lead.create({
    data: {
      contactName: `Ama ${MARK}`,
      contactEmail: `ama.${MARK}@example.test`,
      companyName: "Kumasi Dental",
      source: "GOOGLE_MAPS",
      city: "Kumasi",
    },
  });

  const cold = await composeMessage({
    subject: "quick note",
    body: "Saw your site. One thing on it is costing you enquiries.",
    purpose: "COLD_OUTREACH",
    kind: "MANUAL",
    leadId: lead.id,
  });

  check("a cold email carries the source notice in the HTML", cold.bodyHtml.includes("Google Business listing"));
  check("and in the plain-text alternative", cold.bodyText.includes("Google Business listing"));
  check("naming the basis", cold.bodyText.includes("legitimate interest"));
  check("and pointing somewhere for the rest", /privacy/i.test(cold.bodyText));

  // Both parts of a multipart message are read by somebody. A notice given in
  // one half and not the other has not been given to whoever read the other.
  check(
    "the two parts agree that the notice exists",
    cold.bodyHtml.includes("legitimate interest") && cold.bodyText.includes("legitimate interest"),
  );

  // It is furniture, not the letter. A cold email whose body opens on data
  // protection is a cold email nobody answers.
  const bodyBeforeFooter = cold.bodyText.split("--")[0] ?? "";
  check(
    "the notice is not in the body of the letter",
    !bodyBeforeFooter.includes("legitimate interest"),
    bodyBeforeFooter.slice(0, 120),
  );
  check("the opt-out sentence is still there", /reply "stop"/i.test(cold.bodyText));

  // --- a lead with no recorded source ---------------------------------------

  const unknown = await prisma.lead.create({
    data: {
      contactName: `Kofi ${MARK}`,
      contactEmail: `kofi.${MARK}@example.test`,
      companyName: "Unknown Origin Ltd",
      source: "OTHER",
    },
  });
  const vagueMail = await composeMessage({
    subject: "quick note",
    body: "One line.",
    purpose: "COLD_OUTREACH",
    kind: "MANUAL",
    leadId: unknown.id,
  });
  check("a lead with no recorded source still gets a notice", vagueMail.bodyText.includes("publicly available business listings"));
  check("and is never told a source we do not have", !vagueMail.bodyText.includes("Google Business listing"));

  // --- the negatives ---------------------------------------------------------

  const client = await prisma.client.create({
    data: { name: `Warm Client ${MARK}`, email: `client.${MARK}@example.test`, company: "Warm Client Ltd" },
  });
  const warm = await composeMessage({
    subject: "Your invoice",
    body: "Invoice attached, as agreed.",
    purpose: "INVOICE_DELIVERY",
    kind: "MANUAL",
    clientId: client.id,
  });
  check("a client email carries no source notice", !warm.bodyText.includes("legitimate interest"));
  check("and no unsubscribe link", !/unsubscribe/i.test(warm.bodyText));

  // The gate is one flag, so this proves the flag rather than the purpose list.
  const rendered = await renderEmail({
    subject: "s",
    body: "b",
    variables: {},
    toEmail: `direct.${MARK}@example.test`,
    appUrl: "https://os.example.test",
    includeUnsubscribe: false,
    leadSource: "GOOGLE_MAPS",
  });
  check(
    "a source passed with the flag off produces no notice",
    !rendered.text.includes("Google Business listing") && !rendered.html.includes("Google Business listing"),
  );

  // --- the email template no longer fetches fonts from Google ---------------

  // Same transfer the website was cleaned of on 4 Sep 2026: a stylesheet link
  // in an email tells Google the recipient's IP address and that they opened a
  // message they never asked for. It cannot be consented away in a footer.
  check("the email shell requests no webfont from Google", !cold.bodyHtml.includes("fonts.googleapis.com"));
  check("nor through an @import", !cold.bodyHtml.includes("@import"));
  check(
    "and the type still has a full fallback stack",
    cold.bodyHtml.includes("-apple-system") && cold.bodyHtml.includes("Arial"),
  );

  // --- the short form, for a channel with no footer -------------------------

  const short = shortSourceNotice({ source: "GOOGLE_MAPS", privacyUrl: "https://dakyworld.com/privacy" });
  check("the short form names the source", short.includes("Google Business listing"));
  check("the short form carries the link", short.includes("https://dakyworld.com/privacy"));
  check(
    "the short form fits a message, not a letter",
    short.length < 110,
    `${short.length} characters: ${short}`,
  );

  // --- the phone channels ----------------------------------------------------

  const phoneLead = await prisma.lead.create({
    data: {
      contactName: `Adwoa ${MARK}`,
      contactPhone: "+233200000111",
      companyName: "Tema Tyres",
      source: "DIRECTORY",
    },
  });

  const firstSms = await composePhoneMessage({
    channel: "SMS",
    purpose: "COLD_OUTREACH",
    kind: "MANUAL",
    body: "Noticed your listing has no website on it.",
    leadId: phoneLead.id,
    route: "LINK",
  });
  check("a first cold SMS carries the source notice", firstSms.body.includes("public business directory"));
  check("and still carries the opt-out", /reply stop/i.test(firstSms.body));

  // Art 14(3)(b) is satisfied by the first communication, and an SMS segment
  // costs money — so a follow-up must not buy a second segment to repeat it.
  // The first message has to have actually gone for this to hold, which is what
  // `isFirstOutbound` counts.
  await prisma.message.updateMany({ where: { id: firstSms.id }, data: { status: "SENT" } });
  const secondSms = await composePhoneMessage({
    channel: "SMS",
    purpose: "COLD_OUTREACH",
    kind: "MANUAL",
    body: "Following up on the note last week.",
    leadId: phoneLead.id,
    route: "LINK",
  });
  check("a follow-up does not repeat it", !secondSms.body.includes("public business directory"), secondSms.body);
  check("but the follow-up still carries the opt-out", /reply stop/i.test(secondSms.body));

  // A message to a number nobody has a lead for still gets an honest notice,
  // never an invented source.
  const strangerThread = await composePhoneMessage({
    channel: "WHATSAPP",
    purpose: "COLD_OUTREACH",
    kind: "MANUAL",
    body: "Hello — one thought about your shopfront.",
    toPhone: "+233200000222",
    toName: `Stranger ${MARK}`,
    route: "LINK",
  });
  check(
    "a number with no lead behind it gets the general phrase",
    strangerThread.body.includes("publicly available business listings"),
  );
  check("and is never told a source we do not have", !strangerThread.body.includes("directory"));

  await prisma.message.deleteMany({ where: { toPhone: { in: ["233200000111", "233200000222"] } } });
  await prisma.messageThread.deleteMany({ where: { phone: { in: ["233200000111", "233200000222"] } } });

  await reset();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((name) => `  - ${name}`).join("\n"));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
