import "dotenv/config";
import { writeFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { draftDocument, sourceHash, type FieldValue } from "../src/services/website/index.js";
import { compileClaudeDynamicTemplate } from "../src/shared/templateCompiler.js";

/**
 * Puts back the base of hosted and imported pages that an SEO tool or Insert
 * section moved while saving a draft.
 *
 * Those tools wrote their result into `sourceHtml` as well as into the draft,
 * and the draft's `$document` records the hash of the base it was made against
 * — so the draft has been stale ever since: layout changes and publishing
 * refused. On a hosted page the base is the last published HTML until one of
 * those tools runs, so where `publishedHtml` hashes to what the draft expects,
 * putting it back makes the draft apply again. Anything else is listed for a
 * person to look at, never guessed.
 *
 *   npx tsx scripts/repairStaleToolDrafts.ts                            # dry run
 *   npx tsx scripts/repairStaleToolDrafts.ts --apply --backup <file>    # writes
 *
 * `--apply` refuses to run without `--backup`, which records every value it is
 * about to replace before anything is written. Each write is conditioned on the
 * draft revision it read, so a page somebody saves meanwhile is left alone.
 */
const apply = process.argv.includes("--apply");
const backupIndex = process.argv.indexOf("--backup");
const backupPath = backupIndex >= 0 ? process.argv[backupIndex + 1] : undefined;
if (apply && !backupPath) {
  console.error("--apply needs --backup <file>, so every replaced value is recorded first.");
  process.exit(2);
}

const hashOf = (html: string) => sourceHash(compileClaudeDynamicTemplate(html));

try {
  const pages = await prisma.sitePage.findMany({
    where: { sourceHtml: { not: null }, NOT: { draft: { equals: Prisma.DbNull } } },
    select: { id: true, siteId: true, title: true, path: true, sourceHtml: true, publishedHtml: true, draft: true, draftRevision: true },
  });

  const repairable: Array<{ id: string; siteId: string; title: string; path: string; draftRevision: number; previous: string; restored: string }> = [];
  const manual: Array<{ id: string; siteId: string; title: string; path: string; why: string }> = [];
  for (const page of pages) {
    const document = draftDocument((page.draft ?? {}) as Record<string, FieldValue>);
    if (!document || document.baseHash === hashOf(page.sourceHtml!)) continue;
    if (page.publishedHtml && hashOf(page.publishedHtml) === document.baseHash) {
      repairable.push({ id: page.id, siteId: page.siteId, title: page.title, path: page.path, draftRevision: page.draftRevision, previous: page.sourceHtml!, restored: page.publishedHtml });
    } else {
      manual.push({ id: page.id, siteId: page.siteId, title: page.title, path: page.path, why: page.publishedHtml ? "the published page is not the base this draft was made against" : "never published, so there is no earlier base to put back" });
    }
  }

  console.log(`${pages.length} hosted or imported page(s) with a draft; ${repairable.length + manual.length} stale.`);
  for (const page of repairable) console.log(`  repair  ${page.siteId} ${page.path} (${page.title})`);
  for (const page of manual) console.log(`  by hand ${page.siteId} ${page.path} (${page.title}) — ${page.why}`);

  if (!apply) {
    console.log("\nDry run: nothing was written. Re-run with --apply --backup <file> to repair.");
  } else {
    writeFileSync(backupPath!, JSON.stringify(repairable.map(({ id, siteId, path, draftRevision, previous }) => ({ id, siteId, path, draftRevision, sourceHtml: previous })), null, 2));
    console.log(`\nBackup of ${repairable.length} replaced value(s) written to ${backupPath}.`);
    let repaired = 0;
    for (const page of repairable) {
      const written = await prisma.$transaction(async (tx) => {
        const result = await tx.sitePage.updateMany({ where: { id: page.id, draftRevision: page.draftRevision }, data: { sourceHtml: page.restored } });
        if (result.count) {
          await tx.siteAuditEvent.create({ data: {
            siteId: page.siteId, kind: "PAGE_BASE_REPAIRED", actorName: "Maintenance script",
            summary: `Put back the published base of ${page.title} so its draft can be published again`,
            detail: { pageId: page.id, path: page.path } as Prisma.InputJsonValue,
          } });
        }
        return result.count;
      });
      if (written) repaired += 1;
      else console.log(`  skipped ${page.path}: saved by somebody while this ran`);
    }
    console.log(`Repaired ${repaired} of ${repairable.length}.`);
  }
} finally {
  await prisma.$disconnect();
}
