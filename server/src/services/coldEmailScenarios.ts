/**
 * The eighteen cold-email scenarios, as data rather than as prose in a prompt.
 *
 * A drafter handed a list of findings and told "pick the strongest" writes a
 * competent email about whatever reads most neatly. The playbook's insight is
 * that a first email is not one letter with a variable in it — it is eighteen
 * different letters, each with its own subject, its own explanation, its own
 * question, and its own thing that must never be said. An expired certificate
 * and a missing link preview are not two degrees of the same conversation, and
 * the guard on Scenario 17 (a public breach in their sector) is not a matter of
 * tone, it is the difference between a useful question and a fear campaign.
 *
 * So the choice of scenario happens **here, in code, from the finding ids the
 * audit actually produced**, and the model is handed one scenario rather than
 * asked to invent the framing. Three things follow from that:
 *
 *  - **A scenario cannot fire without its evidence.** `signals` are real ids
 *    from `companyAudit.ts` and `services/audit/*`. If none is present the
 *    scenario is not offered, so the letter can never be about something
 *    nobody checked.
 *  - **Nine of them are `manual`.** Whether a business has just opened a second
 *    branch, whether several providers are involved, whether a registrar
 *    account is in a person's own name — no fetch establishes any of that. They
 *    are listed so a person can choose one deliberately and supply the
 *    evidence; they are never selected automatically.
 *  - **The guards travel with the scenario**, not with the prompt. "Only say it
 *    can be fixed the same day if the cause has been confirmed" belongs to
 *    Scenario 2 and would be wrong advice attached to any other.
 *
 * ## A guide, not a script — and the difference is load-bearing
 *
 * Everything here divides in two, and confusing the halves ruins the feature.
 *
 * **The guards are rules.** "Never mention fraud", "do not promise a same-day
 * fix", "never name the person on the account" — those bind absolutely, every
 * time. They are the reason a scenario is safe to run at volume at all.
 *
 * **Everything else is calibration.** `guidance` says what the letter has to
 * establish; `subjectExamples` and `exampleAsk` show the register and how small
 * the ask should be. **None of it is text to reuse.** Twenty businesses in one
 * scenario must receive twenty different emails written from twenty different
 * sets of facts — if the subject line and the closing question are the same
 * across all of them this has become a mail merge with eighteen variants, which
 * is exactly what the playbook exists to prevent. So the example wording is
 * named `example*` in the type, framed as calibration in the prompt, and
 * **checked for verbatim reuse before a send** (`coldEmailChecks.ts`). A
 * prospect receiving the same sentence a competitor down the road received is
 * not a hypothetical failure: it is what every outreach tool on the market does.
 *
 * Source: Dakyworld Cold Email Playbook v3 (`server/docs/cold-email-playbook.md`).
 * Where the two disagree, the playbook is the authority and this is the bug.
 */

export interface ColdEmailScenario {
  /** The playbook's own number, so the two can be read side by side. */
  number: number;
  key: string;
  /** The scenario's title, in the reader's terms. */
  name: string;
  /**
   * Finding ids that switch it on, from the audit and the audit team. Empty
   * for a scenario no automated check can establish.
   */
  signals: string[];
  /**
   * True when the evidence has to come from a person. Never chosen
   * automatically; offered so somebody can pick it and supply what it needs.
   */
  manual: boolean;
  /**
   * Which of several firing scenarios wins. Ordered by what is worth the one
   * email a stranger will read: something stopping visitors getting in beats
   * something making the page slower, which beats housekeeping.
   */
  priority: number;
  /** Who inside the business this should reach. */
  contact: string;
  /**
   * Subjects that show the right register — short, specific, honest. Examples,
   * not a list to choose from: twenty businesses in one scenario must not
   * receive twenty identical subject lines.
   */
  subjectExamples: string[];
  /**
   * What this email has to establish, and in what order. Substance, not
   * phrasing — the sentences come from this business's own facts.
   */
  guidance: string;
  /**
   * An example of the *kind* of question this scenario ends on — never the
   * question itself. It is here to calibrate how small the ask should be, and
   * copying it into a letter is the failure this whole field is worded to
   * prevent.
   */
  exampleAsk: string;
  /** What must not be said. Null when there is nothing beyond the general rules. */
  guard: string | null;
  /** What each follow-up adds, when the playbook specifies. */
  followUps?: string[];
}

export const COLD_EMAIL_SCENARIOS: ColdEmailScenario[] = [
  {
    number: 2,
    key: "security-warning",
    name: "Your website shows a security warning",
    signals: ["cert-untrusted", "sec-cert-untrusted", "no-https", "sec-no-https"],
    manual: false,
    // The highest there is. Nothing else on this list stops a visitor reaching
    // the business at all.
    priority: 100,
    contact: "Founder, or whoever is responsible for the website",
    subjectExamples: ["Security warning on {{domain}}", "A quick note about {{domain}}"],
    guidance:
      "Say what was found and what a visitor meets: a browser may show a warning before they can open the site, so people may stop at that screen. State the cause as still needing to be checked — it may be the hosting or a renewal setting — rather than diagnosing it from outside. One issue, nothing else stacked on top.",
    exampleAsk: "Would you like me to check what needs attention?",
    guard:
      "Do NOT say this can be fixed the same day, or that it is free, unless access, the cause and the required change have all been confirmed. From outside, none of them has been. Do not predict lost sales or name a proportion of visitors who leave.",
    followUps: [
      "Day 3: send the evidence — what the warning looks like — with no further sales question.",
      "Day 8: mention the other things that were checked, only if they genuinely were.",
      "Day 14: mention ongoing support only if they have engaged.",
      "Day 21: close it off and hand over the finding without selling.",
    ],
  },
  {
    number: 10,
    key: "holding-page",
    name: "Your domain is showing a holding page",
    signals: ["site-error", "site-unreachable"],
    manual: false,
    priority: 95,
    contact: "Founder or MD",
    subjectExamples: ["Your website address is inactive"],
    guidance:
      "Say what was found at the address and pair it with the evidence that the business is active — recent posts on a named profile, for example. The first thing to check is who controls the account used to manage the address, because that decides what can be changed next.",
    exampleAsk: "Would you like me to help you identify what needs checking?",
    guard:
      "Only send this when recent public activity confirms the business is trading. A holding page at a business that has actually closed is a letter nobody should receive. Never name whoever holds the account.",
  },
  {
    number: 5,
    key: "hard-to-contact",
    name: "Visitors may struggle to contact you",
    signals: ["no-contact-route", "content-no-contact", "content-phone-not-tappable", "no-written-contact"],
    manual: false,
    priority: 90,
    contact: "Founder, or whoever handles enquiries",
    subjectExamples: ["Contact details on your site", "One thing I noticed"],
    guidance:
      "Describe exactly what a person on a phone has to do instead: remember the number, leave the page, type it in by hand. Say that making it tappable is a small page change rather than a project.",
    exampleAsk: "Would you like me to point out the exact place to fix?",
    guard: "Do not claim enquiries have been lost. What is known is that the route is harder, not what it has cost.",
  },
  {
    number: 3,
    key: "mobile-broken",
    name: "Your website is difficult to use on a phone",
    signals: ["not-mobile", "seo-no-viewport"],
    manual: false,
    priority: 85,
    contact: "Founder, Marketing lead, or Sales lead",
    subjectExamples: ["Mobile issue on your website", "One thing I noticed"],
    guidance:
      "Name what is actually wrong on the phone — text running past the edge, a menu that is hard to open — and add the reason they may not have seen it: the site looks fine on a computer, which is where it usually gets reviewed. Offer the screenshot as the whole ask.",
    exampleAsk: "I took a screenshot showing what I mean. Would you like me to send it?",
    guard: "Only send this when a phone-width screenshot or test actually shows it. A missing viewport tag alone is not a broken layout.",
    followUps: [
      "Day 3: send the screenshot, no sales question with it.",
      "Day 8: a comparable project, only if the business, problem and result really are comparable.",
      "Day 14: support, only if they have engaged.",
      "Day 21: close it off.",
    ],
  },
  {
    number: 9,
    key: "no-website",
    name: "Your Google profile has no clear website link",
    signals: ["no-website", "demand-without-destination", "rented-presence"],
    manual: false,
    priority: 80,
    contact: "Founder or MD",
    subjectExamples: ["Your Google listing", "One thing I noticed"],
    guidance:
      "Lead with what was actually found on the profile — the review count and the rating, exactly as they appear — and then the gap: there is limited space beyond the reviews for somebody to learn what is offered and decide how to get in touch. Keep it about what a website would give the profile, not about websites in general.",
    exampleAsk: "Would you like me to outline what that website would need to do?",
    guard:
      "Check the whole profile before writing. A website link sitting in a field nobody looked at makes this letter wrong in its first line. Do not quote a rating or a review count that is not in this run's research.",
  },
  {
    number: 4,
    key: "not-in-google",
    name: "Your website may not be showing in Google",
    signals: ["seo-noindex", "seo-robots-blocked", "seo-no-title", "seo-no-description", "seo-generic-title", "seo-description-length"],
    manual: false,
    priority: 75,
    contact: "Founder or Marketing lead",
    subjectExamples: ["How {{domain}} appears in Google"],
    guidance:
      "Two versions. **Site-wide** when a setting tells search engines not to list the site: say the site itself may work normally, that this setting can keep it out of results, and that it is sometimes left behind after a build or a move — with the cause to be confirmed rather than assumed. **Page-level** when the result has no useful description or the title does not say what the business does: those are the first details a searcher sees, and it is a page edit rather than a rebuild.",
    exampleAsk: "Would you like me to show you the setting and check what Google currently lists?",
    guard: "Do not promise a ranking, a position or a timescale. Do not state how much traffic this has cost.",
  },
  {
    number: 6,
    key: "slow-homepage",
    name: "The homepage takes a long time to load",
    signals: ["perf-image-weight", "perf-speed-index", "perf-first-paint", "slow-site", "perf-ttfb-slow"],
    manual: false,
    priority: 70,
    contact: "Founder or Marketing lead",
    subjectExamples: ["Loading time on {{domain}}"],
    guidance:
      "Use the measured figure and only the measured figure — how many MB of images arrive before the main content shows. Explain it as the images being much larger than the space they occupy, so a phone downloads more than it needs. Say it can make a first visit feel slow, especially on a weaker connection.",
    exampleAsk: "Would you like the list of images to review?",
    guard:
      "Block the draft if the measurement is missing or the test did not complete. A number nobody measured is the fastest way to be corrected by the person reading.",
  },
  {
    number: 1,
    key: "email-spoofable",
    name: "Your business email may be easier to copy",
    signals: ["no-spf", "no-dmarc", "sec-no-spf", "sec-no-dmarc"],
    manual: false,
    priority: 65,
    contact: "Founder, MD, Finance lead, or whoever is responsible for company email",
    subjectExamples: ["A quick note about {{domain}}"],
    guidance:
      "Say it in plain words: the domain does not show which email services are allowed to send using the business address, so receiving mail systems have one less way to check that a message claiming to be from them is genuine. Say explicitly that this does not mean anything is currently wrong. It is a small setting with the domain provider, not a project.",
    exampleAsk: "Would you like me to send you the exact change?",
    guard:
      "Never say they are being impersonated, that invoices are being faked, or that fraud has happened. None of that has been established and all of it is alarming. Do not use the words SPF, DMARC or DNS in the explanation.",
    followUps: [
      "Day 3: send a screenshot or copy of the missing setting, with no further sales question.",
      "Day 8: the other email checks, only if they were actually run.",
      "Day 14: ongoing support, only if they have shown interest.",
      "Day 21: close the conversation and hand over the finding.",
    ],
  },
  {
    number: 12,
    key: "personal-mailbox",
    name: "Your contact email uses a personal mailbox",
    signals: ["free-mail-on-site", "free-mail-contact", "no-business-email"],
    manual: false,
    priority: 60,
    contact: "Founder or MD",
    subjectExamples: ["Your business contact email"],
    guidance:
      "Note that the address on the site is a personal mailbox rather than one on their own domain, and put the point in terms of ownership, recovery access and handover as the team changes.",
    guard:
      "Do not claim that customer history will definitely be lost or that shared access is impossible. Do not name the person whose mailbox it is.",
    exampleAsk: "Would you like me to outline the options?",
  },
  {
    number: 8,
    key: "bare-link",
    name: "Your link appears as a bare address when shared",
    signals: ["no-link-preview", "seo-no-link-preview"],
    manual: false,
    priority: 45,
    contact: "Marketing lead or Founder",
    subjectExamples: ["How your link appears when shared"],
    guidance:
      "Say what was seen when the address was pasted into a sharing app: a bare web address with no image, title or description, which gives people less to go on before deciding whether to open it.",
    exampleAsk: "Would you like me to send you the small change that creates the preview?",
    guard: "Only name WhatsApp or LinkedIn if that exact platform was the one tested.",
  },
  {
    number: 7,
    key: "details-exposed",
    name: "The website reveals unnecessary details",
    signals: ["cms-version-exposed", "sec-generator-version", "sec-version-banner", "sec-admin-link", "outdated-cms"],
    manual: false,
    // Deliberately last of the automated ones. The playbook says to test this
    // scenario carefully and not to use it unless its relevance can be
    // explained, so it should only ever be reached when nothing else fired.
    priority: 20,
    contact: "Founder, or whoever maintains the website",
    subjectExamples: ["One thing I noticed on {{domain}}"],
    guidance:
      "State it flatly and say plainly that neither point proves anything is wrong — they are details that can usually be kept out of public view. The value of the email is the offer to explain whether it is worth changing at all.",
    exampleAsk: "Would you like me to show you what is visible and explain whether it is worth changing?",
    guard:
      "Do not combine two unrelated findings. If the observations have different owners or different importance, use only the stronger one. Never imply the site has been or is about to be broken into.",
  },

  // --- The ones no fetch can establish --------------------------------------
  {
    number: 11,
    key: "domain-control",
    name: "Confirm that the company controls its website address",
    signals: [],
    manual: true,
    priority: 40,
    contact: "Founder, MD or Finance lead",
    subjectExamples: ["Who controls your website address?"],
    guidance:
      "Put it as one administrative detail worth confirming: does the company control the account used to renew the address, change its settings and recover access. Say in the email itself that this is not an accusation about anyone.",
    exampleAsk: "Would you like me to send you a short checklist of what to confirm?",
    guard: "Never name or hint at the individual whose name is on the account. State the business question, never the person.",
  },
  {
    number: 13,
    key: "business-change",
    name: "A specific business change creates a website issue",
    signals: [],
    manual: true,
    priority: 78,
    contact: "Founder or Marketing lead",
    subjectExamples: ["Your new {{city}} location"],
    guidance:
      "Two things have to be true together: a recent, sourced business change, and a separate confirmed website issue it creates — a new branch missing from the site, a new service announced but not described, a new person listed publicly with an outdated contact route. Congratulate briefly, then name what is not yet updated and who that affects.",
    exampleAsk: "Would you like me to show you exactly what needs updating?",
    guard: "A growth announcement on its own is not a reason to write. Without the second half — a confirmed gap — do not send this.",
  },
  {
    number: 14,
    key: "many-providers",
    name: "Several providers are involved",
    signals: [],
    manual: true,
    priority: 35,
    contact: "Founder or MD",
    subjectExamples: ["Who coordinates your online systems?"],
    guidance:
      "Say it looks from the outside as though different providers handle the website, hosting, email and design, and that this can work perfectly well. The useful question is what happens when an issue sits between two of them: is there one person on their side who coordinates it, or does it land on them.",
    exampleAsk: "How is it handled at the moment?",
    guard: "Only use this when the research genuinely supports the observation. Do not criticise any named provider.",
  },
  {
    number: 15,
    key: "unfinished-site",
    name: "The website appears unfinished",
    signals: [],
    manual: true,
    priority: 55,
    contact: "Founder or Marketing lead",
    subjectExamples: ["Unfinished pages on {{domain}}"],
    guidance:
      "Say some pages look like a newer site while others still point at the old one. Allow plainly that projects pause for ordinary reasons; the practical issue is that visitors get different information depending which page they land on.",
    exampleAsk: "Would you like me to map what is live and what still needs attention?",
    guard: "Do not speculate about why it stopped, and never about the previous supplier.",
  },
  {
    number: 16,
    key: "manual-enquiries",
    name: "Enquiries may be handled manually",
    signals: [],
    manual: true,
    priority: 30,
    contact: "Founder or Operations lead",
    subjectExamples: ["How enquiries reach you"],
    guidance:
      "Note where the site sends enquiries and allow that it may be exactly the right channel for their customers. Say plainly that what happens after the message arrives is not visible from outside, and put the improvement as a question rather than a diagnosis.",
    exampleAsk: "How are you handling them at the moment?",
    guard: "Do not assume what happens after the message arrives, and do not describe their process back to them as inefficient.",
  },
  {
    number: 17,
    key: "sector-incident",
    name: "A relevant public incident raises a useful question",
    signals: [],
    manual: true,
    priority: 25,
    contact: "Founder, MD, or whoever manages the website and files",
    subjectExamples: ["One question about your backups"],
    guidance:
      "Name the incident and its source, then ask the one practical question: when was the last backup restored successfully. Say in the email that having a backup and successfully using one are different things, and say explicitly that you are not suggesting anything is wrong with their business.",
    exampleAsk: "Would you like the short checklist I would use?",
    guard:
      "The incident must be recent, genuinely relevant to their sector, and linked in the internal record. Never imply they were affected. This is not a fear campaign and must not be run as one.",
  },
  {
    number: 18,
    key: "reconnect",
    name: "Reconnect with a previous lead",
    signals: [],
    manual: true,
    priority: 50,
    contact: "Whoever the earlier conversation was with",
    subjectExamples: ["One update since we last spoke"],
    guidance:
      "Only when the lead has been quiet for at least six months and there is one genuine new fact about them. Name what was discussed and when, the new fact, and the one issue from that conversation that still appears to be there. Make no reply the acceptable answer.",
    exampleAsk: "If useful, I can send the detail; otherwise, no reply is needed.",
    guard: "Requires a real earlier conversation and a real new fact. Without both it is not a reconnection, it is another cold email.",
  },
];

const BY_KEY = new Map(COLD_EMAIL_SCENARIOS.map((scenario) => [scenario.key, scenario]));

export function scenarioByKey(key: string): ColdEmailScenario | null {
  return BY_KEY.get(key) ?? null;
}

/** Every scenario a person could pick by hand, for the composer's dropdown. */
export function manualScenarios(): ColdEmailScenario[] {
  return COLD_EMAIL_SCENARIOS.filter((scenario) => scenario.manual).sort((a, b) => a.number - b.number);
}

export interface ScenarioChoice {
  scenario: ColdEmailScenario;
  /** The finding ids that put it on the list. Empty for a manual pick. */
  matched: string[];
  /** What else fired, so a person can see what was set aside. */
  alsoAvailable: { key: string; name: string; matched: string[] }[];
}

/**
 * Which of the eighteen this email is, from what the audit found.
 *
 * Returns null when nothing fired, which is a real answer and the same one
 * `caseStrength` gives: there is no confirmed issue worth a stranger's
 * attention, so there is no email. A scenario is never invented to fill the
 * gap, because a letter written without one is the generic letter the whole
 * playbook exists to prevent.
 *
 * Manual scenarios are excluded unless one is asked for by name — they need
 * evidence no fetch can supply, and choosing one automatically would mean
 * writing to somebody about a second branch nobody has confirmed exists.
 */
export function chooseScenario(findingIds: string[], preferKey?: string | null): ScenarioChoice | null {
  if (preferKey) {
    const asked = BY_KEY.get(preferKey);
    if (asked) {
      return { scenario: asked, matched: findingIds.filter((id) => asked.signals.includes(id)), alsoAvailable: [] };
    }
  }

  const present = new Set(findingIds);
  const firing = COLD_EMAIL_SCENARIOS.filter((scenario) => !scenario.manual)
    .map((scenario) => ({ scenario, matched: scenario.signals.filter((signal) => present.has(signal)) }))
    .filter((entry) => entry.matched.length > 0)
    .sort((a, b) => b.scenario.priority - a.scenario.priority);

  if (firing.length === 0) return null;

  const [best, ...rest] = firing;
  return {
    scenario: best.scenario,
    matched: best.matched,
    alsoAvailable: rest.map((entry) => ({ key: entry.scenario.key, name: entry.scenario.name, matched: entry.matched })),
  };
}

/**
 * The scenario as the drafter is told it.
 *
 * Worded with some care. The first version of this said `Subject: use "X"` and
 * `The one question to end on: "Y"` — and a model handed that does exactly what
 * it was told, which would have sent every business in a scenario the same
 * subject line and the same closing sentence. The examples are still here,
 * because showing the register is the only cheap way to convey it, but they are
 * labelled as calibration and the instruction around them says to write fresh.
 */
export function scenarioForPrompt(choice: ScenarioChoice): string {
  const { scenario, matched, alsoAvailable } = choice;
  return [
    `THE SCENARIO THIS EMAIL IS (playbook scenario ${scenario.number} — "${scenario.name}"). Write this one and no other.`,
    matched.length ? `What put it on the list: ${matched.join(", ")}.` : null,
    `Who it should reach: ${scenario.contact}.`,
    `What this email has to establish: ${scenario.guidance}`,
    "",
    "**The two lines below are calibration, not copy.** They show the register and how small the ask should be. Write your own sentences out of this business's own facts. If this email could be sent unchanged to another company in the same situation, it is not finished — and reusing the example wording word for word is flagged before it can go out.",
    `  · a subject in this register: "${scenario.subjectExamples[0]}" — yours should be as short and as plain, and about this business.`,
    `  · an ask this small: "${scenario.exampleAsk}" — yours should cost the reader one word to answer.`,
    scenario.guard ? `\nMUST NOT — a rule, not a suggestion: ${scenario.guard}` : null,
    alsoAvailable.length
      ? `\nAlso found, and deliberately NOT this email: ${alsoAvailable
          .map((other) => other.name)
          .join("; ")}. One issue and one question — leave the rest for another time.`
      : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * The example wording, for the verbatim-reuse check.
 *
 * Deliberately not `guidance`: guidance describes what the letter must
 * establish and a draft is *supposed* to follow it. Only the sentences a writer
 * could lift are checked.
 */
export function exampleWording(scenario: ColdEmailScenario): string[] {
  return [...scenario.subjectExamples, scenario.exampleAsk];
}
