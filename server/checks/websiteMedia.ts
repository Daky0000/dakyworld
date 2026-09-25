import assert from "node:assert/strict";
import { rewriteWebsiteMediaStyle, websiteMediaPreviewUrl, websiteMediaSourceUrl } from "../client/src/lib/websiteMedia.js";

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

console.log("websiteMedia: unpublished uploads, page-relative images, origin isolation, canonical source paths and CSS URL preservation passed");
