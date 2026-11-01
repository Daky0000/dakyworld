import assert from "node:assert/strict";
import { matchesWebsiteMediaUrl, rewriteWebsiteMediaStyle, websiteMediaPreviewUrl, websiteMediaSourceUrl } from "../client/src/lib/websiteMedia.js";

const upload = "/shop/assets/dw/photo.png";
const preview = "/api/website/sites/site/assets/photo/content";
const context = {
  pageUrl: "https://site.test/shop/about/team.html",
  editorUrl: "https://editor.test/website/pages/team",
  assets: [{ url: upload, preview }],
};
const resolve = (value: string) => websiteMediaPreviewUrl(value, context);

assert.equal(resolve(upload), `https://editor.test${preview}`, "unpublished uploads load from the editor origin");
assert.equal(resolve(`https://site.test${upload}`), `https://editor.test${preview}`, "absolute published upload URLs map to the same preview");
assert.equal(resolve("../assets/dw/photo.png"), `https://editor.test${preview}`, "equivalent relative upload URLs map to the same preview");
assert.equal(resolve("images/team.jpg"), "https://site.test/shop/about/images/team.jpg", "relative images use the current page directory");
assert.equal(resolve(preview), `https://editor.test${preview}`, "the external iframe base cannot redirect editor API paths");
assert.equal(resolve(""), "", "empty image values stay empty");
assert.equal(resolve(`https://other.test${upload}`), `https://other.test${upload}`, "another host's matching path is not a site upload");

assert.equal(websiteMediaSourceUrl(`https://editor.test${preview}`, context), upload, "captured preview URLs recover their publish path");
assert.equal(websiteMediaSourceUrl(preview, context), upload);
assert.equal(websiteMediaSourceUrl(`https://site.test${upload}`, context), upload, "captured absolute uploads preserve the canonical draft path");
assert.equal(websiteMediaSourceUrl(`https://other.test${upload}`, context), `https://other.test${upload}`, "source normalization respects URL origins");

const style = `background: linear-gradient(red, blue), url('${upload}'); mask-image: url(#mask); color: red`;
assert.equal(rewriteWebsiteMediaStyle(style, resolve), `background: linear-gradient(red, blue), url("https://editor.test${preview}"); mask-image: url(#mask); color: red`);
assert.equal(rewriteWebsiteMediaStyle(`background-image: url(${upload}), url("images/team.jpg")`, resolve), `background-image: url("https://editor.test${preview}"), url("https://site.test/shop/about/images/team.jpg")`);
const inlineImage = 'background-image: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="); color: red';
assert.equal(rewriteWebsiteMediaStyle(inlineImage, resolve), inlineImage, "data URL payloads remain unchanged");
const escapedImage = String.raw`background-image: url("images/photo\"name.png")`;
assert.equal(rewriteWebsiteMediaStyle(escapedImage, resolve), escapedImage, "escaped CSS URLs remain under browser parsing");
assert.equal(rewriteWebsiteMediaStyle(`background-image: url("https://editor.test${preview}")`, value => websiteMediaSourceUrl(value, context)), `background-image: url("${upload}")`, "preview CSS can be saved without editor URLs");

// matchesWebsiteMediaUrl checks (for replacing parallax backgrounds and images across the page)
assert.ok(matchesWebsiteMediaUrl("/images/hero/hero-1.jpg", "public/images/hero/hero-1.jpg"), "matches root-relative URL against public container path");
assert.ok(matchesWebsiteMediaUrl("images/hero/hero-1.jpg", "/images/hero/hero-1.jpg"), "matches relative URL against root URL");
assert.ok(matchesWebsiteMediaUrl("./images/hero/hero-1.jpg", "/images/hero/hero-1.jpg"), "matches dot relative URL against root URL");
assert.ok(matchesWebsiteMediaUrl("https://example.com/public/images/hero/hero-1.jpg", "/images/hero/hero-1.jpg"), "matches absolute host URL against root path");
assert.ok(matchesWebsiteMediaUrl("/africon-app/public/images/hero/hero-3-infrastructure-bridge.jpg", "https://danayipah-web.github.io/africon-app/images/hero/hero-3-infrastructure-bridge.jpg"), "matches subpath deployment with public container");
assert.ok(matchesWebsiteMediaUrl("public/images/hero/hero-3-infrastructure-bridge.jpg", "https://danayipah-web.github.io/africon-app/images/hero/hero-3-infrastructure-bridge.jpg"), "matches public container repoPath against full deployment URL");
assert.ok(matchesWebsiteMediaUrl("/images/hero/hero-3-infrastructure-bridge.jpg", "https://danayipah-web.github.io/africon-app/images/hero/hero-3-infrastructure-bridge.jpg"), "matches clean web path against full deployment URL");
assert.ok(matchesWebsiteMediaUrl("./images/hero/hero-3-infrastructure-bridge.jpg", "https://danayipah-web.github.io/africon-app/images/hero/hero-3-infrastructure-bridge.jpg"), "matches relative dot path with full deployment URL");
assert.ok(matchesWebsiteMediaUrl("https://editor.test/api/website/sites/site1/assets/asset1/content", "assets/dw/asset1.png", "https://editor.test/api/website/sites/site1/assets/asset1/content"), "matches preview API URL with preview param");
assert.ok(!matchesWebsiteMediaUrl("/images/hero/hero-2.jpg", "/images/hero/hero-1.jpg"), "rejects different image filenames");
assert.ok(!matchesWebsiteMediaUrl("./images/hero/hero-1-industrial-plant.jpg", "https://danayipah-web.github.io/africon-app/images/hero/hero-3-infrastructure-bridge.jpg", "https://danayipah-web.github.io/africon-app/images/hero/hero-3-infrastructure-bridge.jpg"), "rejects hero-1 when targeting hero-3 even with previewUrl");
assert.ok(!matchesWebsiteMediaUrl("https://danayipah-web.github.io/africon-app/images/hero/hero-2-concrete-craft.jpg", "https://danayipah-web.github.io/africon-app/images/hero/hero-3-infrastructure-bridge.jpg", "https://danayipah-web.github.io/africon-app/"), "never matches across different hero slides sharing the site origin");

console.log("websiteMedia: unpublished uploads, page-relative images, origin isolation, canonical source paths and CSS URL preservation passed");
