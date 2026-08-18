# docs

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
