/**
 * What the SEO tab and the client report say a page is called. The title is
 * read out of the page's own markup, so every entity in it has to come back as
 * the character it stands for — the first decoder knew seven, and "DakyXTech®"
 * showed as "DakyXTech&reg;" in the search preview and in the report a client
 * is sent. No database needed.
 */
import assert from "node:assert/strict";
import { extractPageSeo } from "../src/services/websiteSeo.js";

const page = `<!doctype html><html><head><title>DakyXTech&reg; | Digital Systems &amp; Automation &#8212; Accra</title>
<meta name="description" content="Caf&eacute; websites &copy; 2026 &#x2014; fast &amp; simple"></head><body><h1>Hi</h1></body></html>`;
const seo = extractPageSeo(page);
assert.equal(seo.title, "DakyXTech® | Digital Systems & Automation — Accra");
assert.equal(seo.description, "Café websites © 2026 — fast & simple");
console.log("websiteSeoText: titles and descriptions read with every entity decoded");
