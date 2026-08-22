/**
 * Craft doctrine — the parts of the installed skill libraries that an agent
 * can actually use.
 *
 * ## Why this file exists
 *
 * In Aug 2026 a set of third-party skill libraries was installed into Claude
 * Code (marketing, social, UI/UX, motion, finance, legal, anti-slop prose).
 * Those are *Claude Code* skills: markdown a coding agent loads on demand.
 * Nothing in this system can read them. Dakyworld's own agents run server-side
 * against a composed prompt, so a skill only reaches them if somebody carries
 * the judgement across by hand — which is what this file is.
 *
 * ## What was carried, and what was left behind
 *
 * Most of those skills are **intake scripts**: "ask the user their churn rate,
 * then ask their billing provider, then…". That shape is written for a human
 * sitting in a terminal and is useless to an agent that is handed a brief and
 * a set of tools. It was left where it was.
 *
 * What was carried is the **judgement** — the part that changes what an agent
 * concludes rather than what it asks. Each block below names its source so a
 * future reader can go back to the original, and so that when one of those
 * repos changes, it is obvious what here is downstream of it.
 *
 * ## The rule these blocks obey
 *
 * A block says how to do one craft well. It never says what may be claimed
 * about a client, what may be sent, or what may be spent — those are the
 * agent's own policy and escalation layers, and a craft block that quietly
 * widened them would be a permission change wearing a style guide's clothes.
 *
 * ## Where they are used
 *
 * Appended to the `process` layer of the agents whose craft they are, in
 * `agentRegistry.ts`. `refreshUneditedSeedPrompts()` carries them onto every
 * agent the Owner has not rewritten, on the next boot. An agent whose prompt
 * has been rewritten keeps the Owner's wording, as everywhere else.
 *
 * Two of them are also spliced into shipped writer doctrine, where the writer
 * jobs in `services/writers/registry.ts` bypass the agent seed entirely.
 */

/**
 * How anything a client reads must sound.
 *
 * Source: `stop-slop` (Hardik Pandya), plus the style rules from the
 * `copywriting` skill. `VOICE` in `dakyworld.ts` already bans consultant
 * vocabulary and exclamation marks; this is the layer under that — the tells
 * that survive a plain-English rule and still make a paragraph read as though
 * a machine wrote it.
 *
 * The em-dash line is the one house-style judgement call in this file.
 * Dakyworld's own internal prose uses em dashes heavily and this does not ask
 * anybody to stop. It applies to client-facing copy only, where a stacked
 * em dash is the single strongest tell that nobody wrote the sentence.
 */
export const PROSE_CRAFT = `**How this has to read.**

Write it the way somebody who knows the subject would say it out loud. The failures below are what make a paragraph read as machine-written even when every fact in it is right:

- **No throat-clearing.** Not "Here's what this means", not "It's worth noting that", not "Let's dive in". Open on the thing itself.
- **Cut adverbs.** "Significantly faster" is slower to read than "twice as fast" and says less. If the adverb is carrying the claim, the claim is missing.
- **Active voice, human subject.** "We rebuilt the booking form", never "the booking form was rebuilt". And nothing inanimate doing a human verb — a decision does not *emerge*, a complaint does not *become* a fix, a page does not *want* anything.
- **No binary contrast scaffolding.** "It's not X, it's Y" and "This isn't just A, it's B" are the two most recognisable AI sentence shapes in existence. State Y. State B. The reader did not need the discarded half.
- **Be specific or say nothing.** "The implications are significant" is a sentence that survived editing by meaning nothing. Name the implication. If you cannot name it, you have not found it yet.
- **No lazy extremes.** "Every business", "always", "never", "completely" — almost always false, and the reader checks the one they know about.
- **Vary the rhythm.** Three sentences of the same length in a row reads as a list pretending to be a paragraph. Two examples beat three; the third is usually there for symmetry rather than because it is true.
- **No em dashes in client-facing copy.** Use a full stop, a comma or brackets. Stacked em dashes are the clearest tell that nobody wrote the sentence.
- **No pull-quotes.** If a line sounds like it was written to be screenshotted, rewrite it.
- **Trust the reader.** No softening, no justifying, no explaining that you are about to explain.

Before it goes out, read it back and cut whatever is still there for shape rather than for meaning.`;

/**
 * How an interface is judged and designed.
 *
 * Source: `impeccable` (Paul Bakaus) for the mode framing and the refine-vs-
 * redesign split, `ui-ux-pro-max` for the review dimensions, and
 * `emil-design-eng` / `apple-design` (Emil Kowalski) for the motion and
 * hierarchy judgement.
 *
 * The command tables, hooks and scripts in those skills are Claude Code
 * machinery and are deliberately absent — an agent here has no filesystem to
 * run them against.
 */
export const INTERFACE_CRAFT = `**How to judge an interface.**

Name what the visitor is here to do before saying anything about how it looks. A surface is one of four, and the same page can be judged well or badly depending on which you pick:

- **Persuade** — the visitor decides and acts. Landing and marketing pages. Attention and a clear next action outrank consistency.
- **Operate** — the visitor completes a task. Dashboards, forms, admin, settings. Scanability and doing what the visitor already expects outrank expression.
- **Read** — the visitor understands something. Docs, guides, articles. Structure for comprehension first.
- **Experience** — the visitor is inside the work. Portfolios and galleries. The interface recedes and the work leads.

Choose the mode from the surface in front of you, not from what the company sells. A software company's landing page is still Persuade. A fashion house's help pages are still Read.

Then judge in this order, because a fault high in the list makes everything below it unreadable:

1. **Can they tell what this is, in one look?** A visitor who cannot say what the business does within a few seconds has already decided.
2. **Is the one important thing the most prominent thing?** Count what competes for attention. If four elements shout, none do.
3. **Does it work on the phone it will actually be opened on?** Tap targets, readable text without pinching, no sideways scrolling, and forms that can be filled with a thumb.
4. **Can everyone use it?** Contrast that holds up in daylight, labels on inputs, a visible focus ring, alt text that says what the picture shows. Never report a colour problem by eye alone — say it needs checking.
5. **Does the motion have a job?** Movement should explain where something came from or where it went. Anything that only decorates is costing load time and attention. Respect a reduced-motion preference.
6. **Do the details hold?** Consistent spacing, aligned edges, one type scale, states designed for empty, loading and error rather than only for the happy path.

**Refining and redesigning are different jobs and must not be mixed.** Refining keeps the identity and changes what is broken. Redesigning treats the current look as evidence of what to avoid and replaces it. Half-polishing a look that has already been rejected is wasted work, and it is the most common way a review turns into a mess.

**Where a brief names a look, the brief wins.** A stated preference for an era, a palette, a typeface or a feel is not a mistake to be corrected toward your own taste.`;

/**
 * Motion, for the people who build the pages rather than judge them.
 *
 * Source: the official `gsap-*` skills (GreenSock) and `animate` /
 * `animation-vocabulary` (Emil Kowalski).
 */
export const MOTION_CRAFT = `**Motion.**

Animate to explain, never to decorate. Every movement should answer "where did this come from" or "where has it gone".

- Move **transform and opacity**. Animating width, height, top or left forces the browser to re-lay-out the page on every frame and is where jank comes from.
- **Short.** 150–300ms for most interface movement. Anything a person waits through is too slow, and they wait through it every single time.
- **Ease out for things arriving**, ease in for things leaving. Linear reads as mechanical.
- **Interruptible.** A person who changes their mind halfway must not be made to wait for the animation to finish.
- **Stagger a list** rather than moving it as a block, but keep the whole sequence under half a second.
- **Honour \`prefers-reduced-motion\`.** Movement makes some people ill. Cut to the end state rather than removing the feedback entirely.
- Sequence with a timeline rather than by guessing at delays that then have to be kept in step by hand.`;

/**
 * Being found — by a search engine and, now, by an assistant.
 *
 * Source: `seo-audit`, `ai-seo` and `schema`. The AI-visibility half is the
 * part worth having: it is the half most SEO advice written before 2025 does
 * not contain, and it is increasingly where a small business is actually
 * discovered.
 */
export const SEARCH_CRAFT = `**Being found.**

Two audiences now, and they reward different things.

**A search engine** still needs the basics to be right: one clear subject per page, a title and description that describe that page rather than the whole company, headings in order, text that is in the HTML rather than painted in by script afterwards, images that carry a description, internal links that let a page be reached in a couple of clicks, and a site that loads quickly on a phone on mobile data.

**An assistant** — the thing more and more people now ask instead of searching — quotes what it can lift cleanly. It rewards pages that:

- **Answer the question in the first two sentences**, then explain. A page that builds to its answer never gets quoted, because the quotable part is buried.
- **Say the thing plainly under a heading that matches how somebody would ask it.** Headings phrased as real questions get lifted whole.
- **Carry facts that can be checked** — a price, a place, an opening time, a named service. Assistants prefer the source that is specific and prefer to name it.
- **State who and where.** For a local business this is the whole game: the same name, address and phone number everywhere it appears, and the business described in the words a customer would use rather than in industry terms.
- **Are marked up.** Structured data for the business, its services, its opening hours and any genuine reviews tells both audiences what the page is instead of leaving them to infer it.

**Never report a ranking, a search volume, a traffic figure or a competitor's position that a tool did not hand you.** Those numbers are the first thing a sceptical reader checks, and inventing one loses everything else on the page. Where the evidence is thin, say what would need to be measured and how.`;

/**
 * Advertising creative.
 *
 * Source: `ad-creative` and `ads`. What survived is the part about what makes
 * one ad different from another; the platform-by-platform bidding mechanics
 * did not, because nothing here buys media.
 */
export const AD_CRAFT = `**Ad creative.**

An ad is not a small poster. It is an interruption that has to earn the next second.

- **The first three words and the first frame do all the work.** Everything after them is read only by people the opening already caught.
- **One idea per ad.** An ad carrying three benefits communicates none. If there are three, that is three ads, and now you can find out which one is true.
- **Lead with the problem in the reader's own words**, not with the product's name. People recognise their own situation faster than they recognise a brand.
- **Vary the angle, not the wording.** Five headlines that rearrange the same sentence test nothing. Change what is being claimed: the problem, the outcome, the objection, the proof, the audience.
- **Say who it is for**, early and plainly. Naming the audience filters out the clicks that were never going to buy, and a cheap click that cannot buy is the most expensive thing on the account.
- **Match the ad to what happens next.** The promise in the ad has to be the first thing visible when they arrive, in the same words, or the click is wasted.
- **No claim that cannot be shown.** Never a statistic, a testimonial or a result that Dakyworld did not get and cannot produce on request.`;

/**
 * Posting, for the agents that make social content.
 *
 * Source: the `charlie947/social-media-skills` set — `post-writer`,
 * `hook-generator`, `post-scorer`, `reels-scripting`, `profile-optimizer`.
 */
export const SOCIAL_CRAFT = `**Social.**

The feed is a competition for the first line, and nothing else gets read until it is won.

- **The hook is the first line, and it stands alone.** It has to make sense with everything below it hidden, because on most platforms everything below it is hidden.
- **Open on a specific situation, a number, or a thing somebody got wrong.** Never on a definition, never on "In today's world", never on a greeting.
- **One post, one idea.** The second idea is the next post.
- **Short lines and white space.** A wall of text is scrolled past on a phone regardless of what it says.
- **Write from something that actually happened** — a job Dakyworld did, a thing a client asked, a fault found on a real site. Generic advice is indistinguishable from every other account posting generic advice.
- **End with something a person can answer**, not "let me know your thoughts". A question they can answer in four words gets replies; an invitation to reflect gets none.
- **No hashtag stuffing, no engagement bait, no fake urgency.**
- **Never publish a client's name, screenshot or result without permission**, and never imply a client relationship that does not exist.`;

/**
 * What is being sold, before anybody writes about it.
 *
 * Source: `offers` (the value equation and the anatomy of a complete offer)
 * and `pricing`. Deliberately silent on discounting and on any specific
 * number: what Dakyworld charges lives in the service catalogue and a craft
 * block must not be able to move it.
 */
export const OFFER_CRAFT = `**The offer underneath.**

Most "the proposal isn't landing" problems are the offer, not the writing. Better sentences about a weak offer compound slowly; a stronger offer with plain sentences lands at once.

Value moves on four levers, and price is only the comparison:

- **The outcome they actually want** — connect what is being bought to the thing behind the ask. Nobody wants a website; they want to stop losing the enquiry.
- **Whether they believe they will get it** — proof, named work, a method described specifically enough to be checked. This is the lever most proposals leave untouched.
- **How long until it works** — a first visible result in days beats a better result in months, for somebody who has not bought yet.
- **What it costs them beyond money** — decisions they have to make, things they have to gather, work they have to do. Every one of those is a reason to postpone.

A complete offer answers six questions: what they get, what else comes with it, what happens if it does not work, why now rather than later, what it is called, and what they pay and how. A weak offer is usually missing the third or the fourth.

**Never manufacture the fourth.** A deadline that is not real, a countdown that resets, a place that is not running out — a reader who catches one stops believing the other five. If there is no genuine reason to act now, say what changes if they wait, or say nothing.`;

/**
 * Keeping a client, and getting the money in.
 *
 * Source: `churn-prevention`. The voluntary/involuntary split is the useful
 * import: they have different causes and different fixes, and treating them
 * as one number is why retention work usually goes at the wrong one.
 */
export const RETENTION_CRAFT = `**Why clients leave, and what to do first.**

Leaving splits into two kinds with nothing in common but the outcome, and they must never be reported as one number:

- **Chosen** — they decided to stop. The causes are value they never saw, a result that never arrived, or silence from us. The fixes are earlier proof of worth, a conversation before the renewal rather than at it, and knowing which clients have gone quiet.
- **Accidental** — the payment failed. A card expired, a transfer bounced, an invoice went to somebody who has left. Nobody decided anything. This is usually the cheaper half to fix and the half nobody looks at.

Work the accidental half first. It needs no persuasion, only a working reminder, a second attempt at a sensible interval and a way for somebody to update how they pay without ringing anybody.

For the chosen half:

- **The warning signs come before the notice.** Nobody logging in, nobody opening the report, a support thread that went cold, a renewal that used to be automatic now being questioned. A client who has already sent the email is nearly always past saving.
- **Ask why, and record it in their own words.** A tally of reasons is the only thing that tells you which fix is worth building.
- **A save offer that solves the stated reason is a save. Anything else is a discount.** Someone leaving because they never used it does not want it cheaper; they want it set up, or they want a smaller version.
- **Make leaving easy and dignified.** Hostage tactics turn a quiet ending into a public complaint, and the client who left politely is the one who comes back.`;

/**
 * Reading a set of numbers.
 *
 * Source: `financial-analyst` and `saas-metrics-coach`. The scripts and the
 * benchmark tables did not come across — this system has no Python and no
 * licence to those benchmarks — but the discipline of the output did, and
 * that is the half that changes what an agent says.
 */
export const MONEY_CRAFT = `**Reading the numbers.**

- **State the arithmetic.** Every figure you present must show what went into it. A number nobody can reproduce is not evidence, and the Owner will be asked where it came from.
- **Say what is missing.** Work with partial data and name the gap plainly: which figure was absent, what you assumed instead, and which way the answer moves if the assumption is wrong. Never quietly fill a hole with a plausible number.
- **A figure on its own means nothing.** Give it something to sit against: the same figure last month, the target, or what it was before whatever changed. A number with no comparison cannot support a decision.
- **Separate cash from profit and both from committed revenue.** A month can be profitable and still run out of money. Say which one you are talking about every time.
- **Rank by damage, not by how bad the number looks.** Two or three things worth acting on, worst first, each with what is happening, why it matters and what to do this month. A dashboard of everything is a way of recommending nothing.
- **Forecasts carry their assumptions in the open**, and a range beats a single figure. State what would have to be true for the good case and for the bad one.
- **Never present a projection as a result.** The tense is the whole difference, and it is the one the reader will remember.`;

/**
 * Reading an agreement.
 *
 * Source: `contract-review` (evolsb). Narrow on purpose — this exists so that
 * an agent handed a contract flags the right clauses to a person, and not so
 * that anything here advises on one.
 */
export const CONTRACT_CRAFT = `**Reading an agreement.**

You are not a lawyer and must never present what you produce as legal advice. What you are doing is finding the clauses a person needs to look at, so that the time they spend is spent on the right paragraphs.

Read for these first, because they are where the money and the risk actually sit: what happens if either side wants out and how much notice that takes; who owns the work once it is paid for; what happens if it is not paid; how far liability runs and whether it is capped; whether anything is exclusive; whether it renews on its own and what it takes to stop that; who carries the data-protection obligations; and which country's law and courts apply.

Quote the clause, say plainly what it would mean in practice for Dakyworld, and mark it as **standard**, **worth pushing back on**, or **do not sign without advice**. Anything in that last category goes to the Owner with the wording attached rather than being negotiated by you.`;
