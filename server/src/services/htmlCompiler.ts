import zlib from "node:zlib";
import { compileClaudeDynamicTemplate } from "../shared/templateCompiler.js";

export { compileClaudeDynamicTemplate };


/**
 * Unpacks an offline self-contained Claude Artifact bundle HTML.
 * Inlines all scripts, stylesheets, and binary assets (images, fonts) as data: URLs
 * and compiles any dynamic component templates into pure static HTML.
 */
export function unpackClaudeArtifactBundle(rawHtml: string): { html: string; unpacked: boolean } {
  if (!rawHtml.includes('type="__bundler/manifest"') || !rawHtml.includes('type="__bundler/template"')) {
    return { html: rawHtml, unpacked: false };
  }

  const manifestMatch = /<script\b[^>]*\btype=["']__bundler\/manifest["'][^>]*>([\s\S]*?)<\/script>/i.exec(rawHtml);
  const templateMatch = /<script\b[^>]*\btype=["']__bundler\/template["'][^>]*>([\s\S]*?)<\/script>/i.exec(rawHtml);
  if (!manifestMatch || !templateMatch) {
    return { html: rawHtml, unpacked: false };
  }

  try {
    const manifest = JSON.parse(manifestMatch[1]);
    let template: string = JSON.parse(templateMatch[1]);

    const extResMatch = /<script\b[^>]*\btype=["']__bundler\/ext_resources["'][^>]*>([\s\S]*?)<\/script>/i.exec(rawHtml);
    const extResources: Array<{ id: string; uuid: string }> = extResMatch ? JSON.parse(extResMatch[1]) : [];

    const assetMap: Record<string, { mime: string; dataUrl: string; text: string | null }> = {};
    for (const [uuid, entry] of Object.entries(manifest as Record<string, { mime: string; data: string; compressed?: boolean }>)) {
      const rawBuf = Buffer.from(entry.data, "base64");
      let finalBuf = rawBuf;
      if (entry.compressed) {
        try {
          finalBuf = zlib.gunzipSync(rawBuf);
        } catch {
          finalBuf = rawBuf;
        }
      }
      const dataUrl = `data:${entry.mime};base64,${finalBuf.toString("base64")}`;
      const isText =
        entry.mime.startsWith("text/") ||
        entry.mime.includes("javascript") ||
        entry.mime.includes("json");
      assetMap[uuid] = {
        mime: entry.mime,
        dataUrl,
        text: isText ? finalBuf.toString("utf8") : null,
      };
    }

    // Build resource map for window.__resources
    const resourceMap: Record<string, string> = {};
    for (const entry of extResources) {
      if (assetMap[entry.uuid]) {
        resourceMap[entry.id] = assetMap[entry.uuid].dataUrl;
      }
    }

    // Extract scripts from extResources (e.g., React, ReactDOM)
    const scriptUuids = new Set<string>();
    const headScripts: string[] = [];

    const reactEntry = extResources.find(
      (e) => e.id.includes("react.production") || e.id.endsWith("/react.js") || e.id.includes("react@")
    );
    if (reactEntry && assetMap[reactEntry.uuid]?.text) {
      headScripts.push(`<script>${assetMap[reactEntry.uuid].text}</script>`);
      scriptUuids.add(reactEntry.uuid);
    }

    const reactDomEntry = extResources.find(
      (e) => e.id.includes("react-dom.production") || e.id.endsWith("/react-dom.js") || e.id.includes("react-dom@")
    );
    if (reactDomEntry && assetMap[reactDomEntry.uuid]?.text) {
      headScripts.push(`<script>${assetMap[reactDomEntry.uuid].text}</script>`);
      scriptUuids.add(reactDomEntry.uuid);
    }

    for (const entry of extResources) {
      if (!scriptUuids.has(entry.uuid)) {
        const asset = assetMap[entry.uuid];
        if (asset?.text && (asset.mime.includes("javascript") || entry.id.endsWith(".js"))) {
          headScripts.push(`<script>${asset.text}</script>`);
          scriptUuids.add(entry.uuid);
        }
      }
    }

    // If a <script src="uuid"></script> in template references a JS asset, inline its code directly in-place
    template = template.replace(
      /<script\b([^>]*?)\bsrc\s*=\s*["']([0-9a-f-]{36})["']([^>]*?)>\s*<\/script>/gi,
      (match, before, uuid, after) => {
        const asset = assetMap[uuid];
        if (asset?.text) {
          scriptUuids.add(uuid);
          return `<script${before}${after}>${asset.text}</script>`;
        }
        return match;
      }
    );

    // Replace all remaining asset UUIDs in template with data URLs (images, fonts, stylesheets)
    for (const [uuid, asset] of Object.entries(assetMap)) {
      if (!scriptUuids.has(uuid)) {
        template = template.split(uuid).join(asset.dataUrl);
      }
    }

    // Strip integrity + crossorigin that might block data: or inlined scripts
    template = template.replace(/\s+integrity="[^"]*"/gi, "").replace(/\s+crossorigin="[^"]*"/gi, "");

    // Prepare window.__resources injection
    const resourceScript =
      Object.keys(resourceMap).length > 0
        ? `<script>window.__resources = ${JSON.stringify(resourceMap).replace(/<\//g, "<\\/")};</script>`
        : "";

    const injection = [resourceScript, ...headScripts].filter(Boolean).join("\n");
    if (injection) {
      const headOpen = /<head\b[^>]*>/i.exec(template);
      if (headOpen) {
        const idx = headOpen.index + headOpen[0].length;
        template = template.slice(0, idx) + "\n" + injection + "\n" + template.slice(idx);
      } else if (template.includes("</head>")) {
        template = template.replace("</head>", `${injection}\n</head>`);
      } else {
        template = `${injection}\n${template}`;
      }
    }

    // Compile dynamic templates if present
    template = compileClaudeDynamicTemplate(template);

    return { html: template, unpacked: true };
  } catch (err) {
    console.error("Failed to unpack Claude artifact bundle:", err);
    return { html: rawHtml, unpacked: false };
  }
}

/**
 * Universal preparation for any imported HTML.
 * Unpacks bundles if needed, compiles dynamic component templates into static HTML,
 * and ensures full compatibility with the visual website editor and public preview.
 */
export function prepareImportedHtml(rawHtml: string): string {
  if (!rawHtml || typeof rawHtml !== "string") return rawHtml;
  let html = rawHtml;
  if (html.includes('type="__bundler/manifest"') && html.includes('type="__bundler/template"')) {
    const unpacked = unpackClaudeArtifactBundle(html);
    if (unpacked.unpacked) {
      html = unpacked.html;
    }
  }
  html = compileClaudeDynamicTemplate(html);
  return html;
}
