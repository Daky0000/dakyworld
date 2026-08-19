# Cold email playbook (v3)

The owner's doctrine for outbound prospecting, and where each part of it is
enforced in the code. **Where this and the code disagree, this is right and the
code is the bug.**

It supports one-time projects and ongoing support. Every email is a draft for a
person to approve — nothing here sends.

---

## 0. The rules

**Only write about what was confirmed.** A check that failed, timed out or did
not complete is not a finding. "Not checked" is not "broken". If the site could
not be reached, do not write that the business has no website — check again.
*Enforced in `companyAudit.fetchSite()`, which only turns "no DNS record on
every candidate" into a finding and leaves every other failure as a note.*

**Keep facts separate from possibilities.** State the confirmed observation,
then what it may make harder. Do not claim it caused lost sales, fraud or
complaints unless the evidence proves it.

> Not: "Customers are leaving your website."
> Write: "People using a phone may find it harder to read the page or contact you."

**Use everyday language.** No SPF, DMARC, DNS, robots.txt, Open Graph, LCP,
metadata, structured data or page source in the first explanation. If a term
genuinely helps, explain the issue first and name the term afterwards. In most
first emails it can be left out completely. *Warned on by
`coldEmailChecks.preSendCheck()`.*

**Say who you are and why you are writing, in the first two lines.**
"Daky here from Dakyworld. I was looking at {{domain}} before writing and
noticed one thing worth your attention." No long company introduction.
*Blocked on if missing.*

**Do not name private people.** Not domain owners, former suppliers, employees,
freelancers or personal mailbox holders. State the business risk without
identifying an individual.

**One issue and one question.** Not a list of problems. It should read as a
personal note, not an audit report. *The scenario chooser picks one and reports
what it set aside; the checker warns on a second question.*

**Check every name and number.** Every name, date, screenshot, figure and
address comes from the current research run. A missing detail blocks the email
rather than shipping an unfinished draft. *Blocked on: unresolved `{{merge}}`
fields.*

**Ask permission to continue.** The first email offers a screenshot, an
explanation or a short checklist. It does not ask for a meeting.

**Include a simple opt-out.** *Appended to every cold email by
`emailRender.renderEmail()`, so it cannot be forgotten:*

> If you'd rather I didn't write again, reply "stop" and I'll close this off.

**No price in a first email.** A number belongs in a proposal, after they
understand the issue and want help. *Blocked on.*

**Human review is required.** A person confirms the finding is correct,
relevant, fairly worded and going to the right contact.

---

## 1. Style and sending

| | |
|---|---|
| Length | 70–120 words. Clarity over the exact count. |
| Subject | Short, specific, honest. Never disguised as a reply or a system alert. No exclamation marks. |
| Tone | Plain, conversational. One person who looked carefully. No "touching base", "circle back", "unlock growth", "reach out". |
| Ask | One question, answerable in one line, offering something rather than requesting it. "Would you like me to send the screenshot?" shows the *size*, not the wording. |
| Delivery | Plain text, no short links, at most one normal link. |
| WhatsApp | In the signature, not the body: +233 545 950 611. |
| Timing | Tuesday–Thursday, Accra business hours. A test position, not a proven fact. |

**Follow-up sequence: day 0, 3, 8, 14, 21.** A test position, not a universal
best practice. Suppress the contact after the final message; never move them
into another campaign.

---

## 2. The eighteen scenarios

**A guide, not a script.** Each scenario says what the letter has to establish
and how small the ask should be. The worked emails in the owner's document show
the register — they are examples, not templates, and their sentences are not to
be reused. If an email could be sent unchanged to the next business with the
same fault, it is not finished; twenty businesses in one scenario should receive
twenty different letters. `coldEmailChecks.ts` flags a draft that reuses the
example wording word for word.

The exception is a **guard**. Those are rules, they bind every time, and they
are the reason a scenario is safe to run at volume.

The substance, the register examples and the guard for each one live in
[`server/src/services/coldEmailScenarios.ts`](../src/services/coldEmailScenarios.ts)
so the choice is made from evidence rather than by a model picking whichever
reads most neatly. Eleven are chosen automatically from audit findings; seven
need a person to supply the evidence and are never chosen on their own.

| # | Scenario | Chosen by |
|---|---|---|
| 2 | Your website shows a security warning | `cert-untrusted`, `sec-cert-untrusted`, `no-https` |
| 10 | Your domain is showing a holding page | `site-error`, `site-unreachable` |
| 5 | Visitors may struggle to contact you | `no-contact-route`, `content-phone-not-tappable` |
| 3 | Your website is difficult to use on a phone | `not-mobile`, `seo-no-viewport` |
| 9 | Your Google profile has no clear website link | `no-website`, `demand-without-destination` |
| 4 | Your website may not be showing in Google | `seo-noindex`, `seo-no-description`, `seo-generic-title` |
| 6 | The homepage takes a long time to load | `perf-image-weight`, `perf-speed-index`, `slow-site` |
| 1 | Your business email may be easier to copy | `no-spf`, `no-dmarc` |
| 12 | Your contact email uses a personal mailbox | `free-mail-on-site`, `no-business-email` |
| 8 | Your link appears as a bare address when shared | `no-link-preview` |
| 7 | The website reveals unnecessary details | `sec-generator-version`, `sec-admin-link` — **use with care** |
| 11 | Confirm the company controls its website address | a person |
| 13 | A business change creates a website issue | a person |
| 14 | Several providers are involved | a person |
| 15 | The website appears unfinished | a person |
| 16 | Enquiries may be handled manually | a person |
| 17 | A public incident raises a useful question | a person |
| 18 | Reconnect with a previous lead | a person |

Two guards worth repeating outside their scenario:

- **Scenario 2** — do not say it can be fixed the same day, or that it is free,
  unless access, the cause and the required change have all been confirmed.
  None of them is visible from outside.
- **Scenario 17** — the incident must be recent, relevant and recorded. Never
  imply they were affected. This is not a fear campaign.

---

## 3. Follow-ups

Each touch adds something the last one did not.

| Touch | Day | Its job |
|---|---|---|
| 1 | 0 | Identify yourself, one confirmed issue, one small question. |
| 2 | 3 | Deliver the evidence you offered. No second sales question. |
| 3 | 8 | A comparable example — only if it genuinely is comparable. Otherwise skip. |
| 4 | 14 | How ongoing support prevents this class of problem — only if they engaged. |
| 5 | 21 | Close it. Hand over the finding. No reply needed. Do not sell. |

"Just checking in" is not a message; it is an admission there was nothing to say.

---

## 4. Pre-send checklist

Nine of the fifteen are arithmetic on the rendered text and run in
[`coldEmailChecks.ts`](../src/services/coldEmailChecks.ts) — merge fields, the
opt-out, identification, one question, unsupported claims, marketing filler,
plain language, the subject, the length, and no price. They are returned with
every draft and the blocking ones stop a send.

The other six are judgement and are listed for the reviewer, never ticked by
code: the claim traces to this run; the check completed; the finding is still
current; no private individual is named; the question is proportionate; and this
is the right contact at a reasonable time.

---

## 5. What to measure

Positive replies · qualified conversations · consultations booked · proposals
sent · revenue · negative replies and opt-outs · spam complaints · hard bounces ·
**corrections from prospects who say a finding is wrong** · time to a qualified
conversation · whether email, WhatsApp or a warm introduction performs best.

A correction is not just a lost opportunity — it usually means the audit, the
research or the wording needs fixing. Stop a campaign if a finding is repeatedly
challenged, the source is unclear, or complaints rise.

---

## 6. Still being tested

Three messages vs five · short vs descriptive subjects · one vs two sentences of
identification · email vs WhatsApp vs a warm introduction · which scenarios suit
Ghanaian businesses · whether follow-ups should stop at no engagement.

The original benchmark figures came from vendor studies of US and European B2B
outreach and have not been proven for Ghanaian businesses. Replace them with
Dakyworld's own numbers as soon as there are enough.

---

## 7. Where this lives

| Part | File |
|---|---|
| Scenarios, signals, guards | `src/services/coldEmailScenarios.ts` |
| Pre-send checklist | `src/services/coldEmailChecks.ts` |
| The drafter's rules | `src/lib/emailDrafter.ts` |
| Opt-out, signature, unsubscribe | `src/services/emailRender.ts` |
| Sequences and timing | `src/services/emailSequences.ts` |
| Findings the scenarios read | `src/services/companyAudit.ts`, `src/services/audit/*` |
| Research, evidence, case strength | `src/services/leadPrep.ts` |
| The agents that write it | `outreach.writer`, `outreach.followup` in `src/services/agentRegistry.ts` |
| The same doctrine for Claude Code | `~/.claude/skills/dakyworld-cold-email/SKILL.md` |

Nothing in this playbook sends automatically. It creates drafts for approval.
