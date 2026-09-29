import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.js";
import { autoPopulateSitePaletteFromHtml, extractColorsFromHtml } from "../src/services/website/pageColors.js";

let checks = 0;
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks += 1;
};
const equal = (name: string, actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected, name);
  checks += 1;
};

async function run() {
  console.log("Starting pageColors integration checks...");

  // 1. Create a test site without palette
  const testSiteSlug = `test-palette-${Date.now()}`;
  const site = await prisma.site.create({
    data: {
      name: "Color Palette Test Site",
      slug: testSiteSlug,
      publicUrl: `https://${testSiteSlug}.example.com`,
    },
  });

  try {
    // Verify initial site has no colors
    const initialSettings = (site.settings as Record<string, any>) ?? {};
    check("initial site has no colors", !initialSettings.colours || initialSettings.colours.length === 0);

    // 2. HTML to import with distinctive brand colors
    const importedHtml = `
      <!doctype html>
      <html>
      <head>
        <style>
          :root {
            --brand-primary: #FF5722;
            --brand-secondary: #009688;
          }
          .hero { background-color: var(--brand-primary); color: #FFFFFF; }
          .accent { color: #E91E63; }
        </style>
      </head>
      <body>
        <div style="background-color: #673AB7; color: rgb(255, 235, 59);">
          <svg fill="#4CAF50"><path d="..."/></svg>
        </div>
      </body>
      </html>
    `;

    // 3. Test autoPopulateSitePaletteFromHtml
    const populated = await autoPopulateSitePaletteFromHtml(site.id, importedHtml);
    console.log("Populated colours:", populated);

    check("populated is non-empty", populated.length > 0);
    check("contains #FF5722", populated.includes("#FF5722"));
    check("contains #009688", populated.includes("#009688"));
    check("contains #E91E63", populated.includes("#E91E63"));
    check("contains #673AB7", populated.includes("#673AB7"));
    check("contains #FFEB3B", populated.includes("#FFEB3B"));
    check("contains #4CAF50", populated.includes("#4CAF50"));
    check("contains #FFFFFF", populated.includes("#FFFFFF"));

    // Verify DB update
    const updatedSite = await prisma.site.findUnique({
      where: { id: site.id },
      select: { settings: true },
    });
    const updatedSettings = (updatedSite?.settings as Record<string, any>) ?? {};
    check("site settings in DB contains populated colours", Array.isArray(updatedSettings.colours));
    equal("colours in DB matches populated", updatedSettings.colours, populated);

    // 4. Test re-population with new colors doesn't wipe existing
    const secondHtml = `<div style="color: #9C27B0;">Extra</div>`;
    const enriched = await autoPopulateSitePaletteFromHtml(site.id, secondHtml);
    check("enriched contains previous #FF5722", enriched.includes("#FF5722"));
    check("enriched contains new #9C27B0", enriched.includes("#9C27B0"));

    console.log(`pageColorsIntegration: ${checks} checks passed`);
  } finally {
    // Cleanup
    await prisma.sitePage.deleteMany({ where: { siteId: site.id } }).catch(() => {});
    await prisma.site.delete({ where: { id: site.id } }).catch(() => {});
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  });
