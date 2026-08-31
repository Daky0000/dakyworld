"""Binds the four books into one volume, with real page numbers and an outline.

The three standing documents and the two fragments from `build-system-doc.ts`
are printed to PDF separately, because each is its own document with its own
cover and its own reason to be rebuilt. This does the part none of them can do
alone: it finds where every scenario actually starts once they are bound in
order, writes those page numbers into the front matter, reprints it, merges,
and adds the bookmark tree.

The page numbers are found by searching the printed PDFs rather than counted by
hand. A scenario index whose numbers have drifted is worse than no index: it
sends somebody to a page about something else and they conclude the process is
not written down anywhere.

    python build-system-volume.py            # from server/

Needs PyMuPDF and Chrome. `build-system-doc.ts` must have run first, and every
book must have been printed.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "docs")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

OUT_NAME = "Dakyworld-OS-Agent-System.pdf"
OUT = os.path.join(DOCS, OUT_NAME)
# Where the founder actually looks for it, beside the other compiled documents.
ALSO = os.path.abspath(os.path.join(HERE, "..", "..", OUT_NAME))

# The books, in reading order. The key is what the front matter's tokens use.
BOOKS = [
    ("front", "agent-system-front", "Front matter — contents and the scenario index"),
    ("book1", "agent-master-workflow", "Book One — The Agent Master Workflow"),
    ("book2", "agent-operations", "Book Two — How the workforce runs"),
    ("book3", "agent-system-current", "Book Three — What runs now"),
    ("book4", "dakyworld-os-reference", "Book Four — The complete reference"),
]

# Every scenario in the index, and the words to look for. Deliberately phrases
# from the heading itself rather than section numbers: a section can be
# renumbered by an edit above it, and a phrase that no longer exists fails
# loudly here instead of printing a wrong page.
ANCHORS: dict[str, tuple[str, str]] = {
    "capture1": ("book1", "Getting a business into the pipeline"),
    "qualify": ("book1", "Deciding who is worth writing to"),
    "outreach": ("book1", "The first email, and the four that follow it"),
    "proposal": ("book1", "Turning a conversation into a number"),
    "signature": ("book1", "From a signature to a plan"),
    "delivery": ("book1", "The specialists do the work"),
    "handover": ("book1", "Finishing properly"),
    "invoice": ("book1", "Getting paid"),
    "retainer": ("book1", "Where a one-off project is meant to lead"),
    "commission": ("book1", "Commissioning it"),
    "capture2": ("book2", "how a lead appears"),
    "mailroom": ("book2", "what happens to a reply"),
    "phone": ("book2", "the leads with a number and no email"),
    "approvals": ("book2", "the other half of a preview"),
    "hiring": ("book2", "how the workforce grows itself"),
    "rehearsal1": ("book2", "watching the whole workforce work"),
    "budgets": ("book2", "what it may spend before it stops itself"),
    "routing": ("book2", "Model routing, and what happens when a vendor is down"),
    "writers": ("book2", "Who writes what"),
    "task": ("book2", "One task, end to end"),
    "clock": ("book2", "The clock"),
    "gate": ("book2", "What an agent may do"),
    "day": ("book2", "All of it, switched on"),
    "prompt": ("book3", "The prompt, as it is assembled today"),
    "boundaries": ("book3", "Boundaries: what, and about whom"),
    "activate": ("book3", "Switching the workforce on"),
    "rehearsal2": ("book3", "Switching the workforce on"),
    "pace": ("book3", "how often, as against how much"),
    "autonomy": ("book3", "Autonomy as a decision with a record"),
    "escalations": ("book3", "A question that was never answered"),
    "induction": ("book3", "The induction of a hired agent"),
    "symptoms": ("book3", "What all of it changes at a desk"),
    "roster": ("book4", "Every agent, and what it may reach"),
    "catalogue": ("book4", "Every tool, and what it costs to be wrong"),
}

# Anything at least this large is a heading rather than body text. Read off the
# stylesheet: stage headings are 20pt, part dividers 30pt, body 9.6pt.
HEADING_PT = 17.5
PART_PT = 22.0


def path_for(stem: str, ext: str) -> str:
    return os.path.join(DOCS, f"{stem}.{ext}")


def print_pdf(stem: str) -> None:
    """Chrome, headless. Absolute paths on both sides or it says 'Access is denied'."""
    html = path_for(stem, "html").replace("\\", "/")
    pdf = path_for(stem, "pdf").replace("\\", "/")
    subprocess.run(
        [
            CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
            "--virtual-time-budget=30000", f"--print-to-pdf={pdf}", f"file:///{html}",
        ],
        check=True, capture_output=True,
    )


def headings(doc: fitz.Document) -> list[tuple[int, float, str]]:
    """Every heading in a document as (page index, point size, text).

    Spans are joined per block, because a two-line title is two lines of spans
    and a bookmark reading "Agents, Instructions," is not a bookmark.
    """
    found: list[tuple[int, float, str]] = []
    for page in doc:
        for block in page.get_text("dict")["blocks"]:
            parts: list[str] = []
            size = 0.0
            for line in block.get("lines", []):
                for span in line["spans"]:
                    if span["size"] >= HEADING_PT and span["text"].strip():
                        parts.append(span["text"].strip())
                        size = max(size, span["size"])
            if parts:
                text = re.sub(r"\s+", " ", " ".join(parts)).strip()
                if text:
                    found.append((page.number, size, text))
    return found


def find_page(doc: fitz.Document, phrase: str, heads: list[tuple[int, float, str]]) -> int | None:
    """The page a section starts on: where its phrase appears as a heading.

    Falls back to any page carrying the phrase, so an index line resolves to
    something rather than to nothing — but a heading always wins, because a
    phrase quoted inside a paragraph is not where the section begins.
    """
    for number, size, text in heads:
        if phrase in text and size >= HEADING_PT:
            return number
    for page in doc:
        if phrase in page.get_text():
            return page.number
    return None


def fill_front(tokens: dict[str, int]) -> None:
    """Writes the page numbers into the front matter and reprints it."""
    source = path_for("agent-system-front", "html")
    html = open(source, encoding="utf-8").read()
    if "{{P:" not in html:
        raise SystemExit(
            "The front matter has no page-number tokens left in it — it is a filled copy "
            "from a previous run. Re-run `npx tsx build-system-doc.ts` first."
        )
    for key, value in tokens.items():
        html = html.replace("{{P:%s}}" % key, str(value))
    left = re.findall(r"\{\{P:([a-z0-9]+)\}\}", html)
    if left:
        raise SystemExit(f"No page number was found for: {', '.join(sorted(set(left)))}")
    open(source, "w", encoding="utf-8").write(html)
    print_pdf("agent-system-front")


def main() -> None:
    for _, stem, _ in BOOKS:
        if not os.path.exists(path_for(stem, "pdf")):
            raise SystemExit(f"{stem}.pdf has not been printed — see docs/README.md.")

    # Pass one: page counts as they stand, with the tokens still in the front
    # matter. Filling them only ever shortens the text, so the count is stable
    # in practice — and it is checked below rather than assumed.
    docs = {key: fitz.open(path_for(stem, "pdf")) for key, stem, _ in BOOKS}
    counts = {key: doc.page_count for key, doc in docs.items()}

    def offsets(counts: dict[str, int]) -> dict[str, int]:
        running = 0
        out: dict[str, int] = {}
        for key, _, _ in BOOKS:
            out[key] = running
            running += counts[key]
        return out

    starts = offsets(counts)
    heads = {key: headings(doc) for key, doc in docs.items()}

    tokens: dict[str, int] = {}
    for key, _, _ in BOOKS:
        tokens[key] = starts[key] + 1
    tokens["contents"] = starts["front"] + 2
    tokens["scenarios"] = starts["front"] + 3
    tokens["total"] = sum(counts.values())

    missing: list[str] = []
    for name, (book, phrase) in ANCHORS.items():
        page = find_page(docs[book], phrase, heads[book])
        if page is None:
            missing.append(f"{name} ({book}: {phrase!r})")
            continue
        tokens[name] = starts[book] + page + 1
    if missing:
        raise SystemExit("These sections were not found in the printed books:\n  " + "\n  ".join(missing))

    for doc in docs.values():
        doc.close()

    fill_front(tokens)

    front = fitz.open(path_for("agent-system-front", "pdf"))
    if front.page_count != counts["front"]:
        # The numbers are shorter than the tokens, so this would mean the front
        # matter reflowed and every page number after it is now one out.
        raise SystemExit(
            f"The front matter changed length when the page numbers went in "
            f"({counts['front']} -> {front.page_count}). Re-run: the second pass will be correct."
        )
    front.close()

    volume = fitz.open()
    toc: list[list] = []
    for key, stem, label in BOOKS:
        doc = fitz.open(path_for(stem, "pdf"))
        start = volume.page_count
        volume.insert_pdf(doc)
        toc.append([1, label, start + 1])
        for number, size, text in headings(doc):
            # The cover of each book repeats its own title in 30pt+; the book
            # already has a level-1 entry, so it is skipped.
            if number == 0:
                continue
            if len(text) > 90:
                continue
            # A stat tile is a 19pt number — "51", "69", "60s", "+MCP". Set at
            # heading size because it is meant to be read as one, and useless as
            # a bookmark, so a heading has to be words rather than a figure.
            if len(text) < 6 or len(re.findall(r"[A-Za-z]", text)) < 2:
                continue
            toc.append([2 if size >= PART_PT else 3, text, start + number + 1])
        doc.close()

    # A bookmark tree may never skip a level: a book whose first heading is a
    # 20pt section head would jump 1 -> 3, which PyMuPDF refuses outright.
    previous = 0
    for row in toc:
        row[0] = min(row[0], previous + 1)
        previous = row[0]

    volume.set_toc(toc)
    volume.set_metadata({
        "title": "The Dakyworld OS Agent System",
        "author": "Dakyworld",
        "subject": "Every agent, every tool, every instruction and every workflow, in one volume.",
        "keywords": "agents, workflow, operations, reference",
    })
    volume.save(OUT, deflate=True, garbage=3)
    pages = volume.page_count
    volume.close()

    shutil.copyfile(OUT, ALSO)
    print(f"wrote {OUT} — {pages} pages, {len(toc)} bookmarks, {os.path.getsize(OUT) / 1_048_576:.1f} MB")
    print(f"copied to {ALSO}")


if __name__ == "__main__":
    sys.exit(main())
