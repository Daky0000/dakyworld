# docs

## How the workforce runs

`agent-operations.pdf` — the operating picture of the agent system. Where the
master workflow below describes the *business* flow and the reference prints
every instruction in full, this one describes the **machine**: what an agent is,
what it may call, what happens between a task being raised and a person reading
the result, and everything that runs on the clock without anybody asking.

Six parts and two appendices — the employee record and the ten prompt layers,
the catalogue and the six checks every tool call passes, one task turn by turn
with its checkpoints and end states, the nine jobs on the minute tick, every
process end to end (capture, the mail room, approvals, hiring, rehearsals,
budgets, model routing, who writes what), and one ordinary day with all of it
switched on.

Every number in it is read out of the code at build time — the roster, the
catalogue, the writer registry and the model jobs. **One check it performs while
building**, because it is invisible otherwise: the tools sitting in nobody's
seeded toolkit are counted and named in a warning under Appendix B. That is the
ordinary consequence of `ensureAgents()` only ever creating, and it is the list
to work down the day an agent reports that something cannot be done. It found
eleven on 25 Aug 2026, `email.send` among them.

```bash
# from server/
npx tsx build-operations-doc.ts       # -> docs/agent-operations.html

"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --disable-gpu --no-pdf-header-footer --virtual-time-budget=30000 \
  --print-to-pdf="<absolute path>/docs/agent-operations.pdf" \
  "file:///<absolute path>/docs/agent-operations.html"
```

Forty-seven pages with five sparse ones (the tails of 01, 04, 05 and the two
appendices) is the expected shape. The prose lives in
`workflow/operations-body.html` and the styling in `workflow/operations-head.html`,
which is the master workflow's head plus the components this document adds.
Everything else about rebuilding and checking it — absolute paths, the embedded
fonts, the PyMuPDF page check — is identical to the master workflow below.

## The complete reference

`dakyworld-os-reference.pdf` — every agent, every instruction, every workflow
and every tool, in one document. Where the master workflow below explains how
the company runs in prose somebody wrote, this is the reference behind it, and
**its whole body is generated**: the roster and the ten prompt layers out of
`services/agentRegistry.ts`, the writing jobs out of `services/writers/`
(including the shipped doctrine each one runs on today), the clock out of
`services/scheduler.ts`, and the catalogue — with the arguments each tool takes
and how many agents hold it — out of `services/tools/catalogue.ts`.

Two checks it performs while building, because both are invisible otherwise:
a grant naming a tool the catalogue does not have (a dashed chip, and a warning
callout under the roster), and a tool in nobody's seeded toolkit — which is the
ordinary consequence of `ensureAgents()` only ever creating, and the list to
work down when something "cannot be done".

```bash
# from server/
npx tsx build-reference-doc.ts        # -> docs/dakyworld-os-reference.html

"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --disable-gpu --no-pdf-header-footer --virtual-time-budget=30000 \
  --print-to-pdf="<absolute path>/docs/dakyworld-os-reference.pdf" \
  "file:///<absolute path>/docs/dakyworld-os-reference.html"
```

Sixty-two pages, with nine sparse ones (the tails of the four parts and of the
longer writing briefs) is the expected shape. The agent cards are set at 7.9pt
on purpose: at the body's own size only one fitted on a page and fifty agents
cost fifty half-empty pages. Everything else about rebuilding and checking it —
absolute paths, the embedded fonts, the PyMuPDF page check — is identical to the
master workflow below.

## The Agent Master Workflow

`agent-master-workflow.pdf` — the operating standard for the agent workforce.
Every stage from a business nobody has heard of to a retainer renewing: what
starts each action, who owns it, which tools it calls, what gate it passes, what
ends it, and what makes it stop and ask.

**It is generated, not hand-maintained.** The prose lives in
`workflow/workflow-*.html`; the two appendices — every agent with its toolkit,
and every tool with what it costs to be wrong — are built directly from
`services/agentRegistry.ts` and `services/tools/catalogue.ts`. A reference table
that has drifted from the system is worse than none: somebody grants a tool that
no longer exists, or looks for one added last month and concludes it cannot be
done. So it is read out of the code each time.

### Rebuilding it

Re-run this after **any** change to the agent seeds or the tool catalogue.

```bash
# from server/
npx tsx build-workflow-doc.ts          # -> docs/agent-master-workflow.html

"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --disable-gpu --no-pdf-header-footer --virtual-time-budget=20000 \
  --print-to-pdf="<absolute path>/docs/agent-master-workflow.pdf" \
  "file:///<absolute path>/docs/agent-master-workflow.html"
```

Three things that cost time the first time:

- **Chrome needs absolute paths on both sides.** A relative `--print-to-pdf`
  target fails with "Access is denied", which is not what it means.
- **The brand fonts are embedded, not linked.** Chrome's print path finishes
  before a linked Google Font arrives, and the first build shipped with Segoe UI
  in every heading. `workflow/fonts/faces.json` holds the latin and latin-ext
  subsets of the three variable files, base64-encoded; the builder writes them
  into the page as `@font-face`. To refresh them, fetch the CSS for
  `Space Grotesk`, `DM Sans` and `JetBrains Mono` with a browser user-agent,
  pull the `woff2` URLs for those two subsets, and re-encode — one file per
  family per subset, deduplicated, because Google serves the same variable file
  for every weight.
- **Pagination is tuned.** Steps, callouts and the org chart never split;
  reference tables do. Only Section 04 and the two appendices force a page
  break — an earlier draft broke before every stage and cost thirteen half-empty
  pages.

### Checking it after a rebuild

```bash
python -c "
import fitz
d = fitz.open('docs/agent-master-workflow.pdf')
print('pages:', d.page_count)
print('sparse:', [i+1 for i in range(d.page_count)
      if max([x[3] for x in d[i].get_text('blocks')], default=0)/d[i].rect.height < 0.55])
"
```

Thirty pages, with three sparse ones (the tails of Section 02 and the two
appendices), is the expected shape. A jump in either number means a break rule
is fighting the content — look at the page before the sparse one.

Set `PYTHONIOENCODING=utf-8` before printing any extracted text on Windows, or
the middot in the letterhead comes back as a CJK ideograph and a correct
document looks broken.
