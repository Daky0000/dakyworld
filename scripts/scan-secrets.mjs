#!/usr/bin/env node
/**
 * Refuses to let a credential into the repository.
 *
 * The history was clean when this was written — every `.env` has always been
 * ignored and the only connection strings ever committed are `postgres:postgres`
 * and `user:password` in the local-setup docs. This exists so it stays that
 * way, because the cost of finding out otherwise is not a bad commit: it is
 * rotating every key in the business and hoping nobody cloned the repo first.
 * A key committed once is a key that lives in the history forever.
 *
 *   node scripts/scan-secrets.mjs            # the working tree
 *   node scripts/scan-secrets.mjs --staged   # what is about to be committed
 *   node scripts/scan-secrets.mjs --history  # every commit ever made
 *
 * Exits non-zero on a finding, so it works as a pre-commit hook and as a CI
 * step without any wrapping.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/**
 * Each pattern is anchored on a vendor's own prefix rather than on entropy.
 * A generic "long random string" rule fires on every minified bundle, every
 * hash and every base64 image, and a scanner people turn off is worth nothing.
 */
const PATTERNS = [
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI API key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: "Perplexity API key", re: /\bpplx-[A-Za-z0-9]{32,}/ },
  { name: "Stripe secret key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: "Stripe webhook secret", re: /\bwhsec_[A-Za-z0-9]{24,}/ },
  { name: "Apify token", re: /\bapify_api_[A-Za-z0-9]{30,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Slack webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]{20,}/ },
  { name: "Cloudinary URL with secret", re: /cloudinary:\/\/\d+:[A-Za-z0-9_-]{10,}@/ },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "Database URL with a real password", re: /\bpostgres(?:ql)?:\/\/[^\s:@"']+:[^\s:@"']+@/ },
];

/**
 * Placeholders that legitimately look like the real thing. Anything matching
 * one of these is documentation, not a leak.
 */
const ALLOWED = [
  /postgres(?:ql)?:\/\/postgres:postgres@/,
  /postgres(?:ql)?:\/\/user:password@/,
  /postgres(?:ql)?:\/\/[^\s:@"']+:(?:password|changeme|your[-_]?password|xxx+|\.\.\.)@/i,
  /sk-ant-(?:api03-)?(?:xxx|your|example|placeholder|\.\.\.)/i,
  /sk-(?:xxx|your|example|placeholder|\.\.\.)/i,
];

/** Never worth reading: generated, vendored, or binary. */
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.git)\/|\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|docx|xlsx|woff2?|ttf|otf|map)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function findingsIn(text, where) {
  const found = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line.length > 4000) return; // a minified bundle line, not something a person wrote
    for (const { name, re } of PATTERNS) {
      const match = re.exec(line);
      if (!match) continue;
      if (ALLOWED.some((allowed) => allowed.test(match[0]))) continue;
      found.push({ where, line: index + 1, name, sample: `${match[0].slice(0, 12)}…` });
    }
  });
  return found;
}

function scanFiles(paths) {
  const found = [];
  for (const file of paths) {
    if (!file || SKIP_PATH.test(file)) continue;
    try {
      if (statSync(file).size > MAX_BYTES) continue;
      found.push(...findingsIn(readFileSync(file, "utf8"), file));
    } catch {
      // Deleted, renamed, or not text. Nothing to scan.
    }
  }
  return found;
}

function scanHistory() {
  // Only added lines: a secret that was committed and then deleted is still in
  // the history, and its addition is what this has to catch.
  const patch = git("log", "--all", "-p", "--unified=0", "--no-color");
  const found = [];
  let file = "unknown";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (SKIP_PATH.test(file)) continue;
    found.push(...findingsIn(line.slice(1), `${file} (in history)`).map((f) => ({ ...f, line: 0 })));
  }
  return found;
}

const mode = process.argv[2] ?? "--tree";
let findings;

if (mode === "--history") {
  findings = scanHistory();
} else if (mode === "--staged") {
  findings = scanFiles(git("diff", "--cached", "--name-only", "--diff-filter=ACM").split("\n"));
} else {
  findings = scanFiles(git("ls-files").split("\n"));
}

if (findings.length === 0) {
  console.log(`No credentials found (${mode.replace("--", "")}).`);
  process.exit(0);
}

console.error(`\nFound ${findings.length} thing(s) that look like credentials:\n`);
for (const f of findings) {
  console.error(`  ${f.where}${f.line ? `:${f.line}` : ""} — ${f.name} (${f.sample})`);
}
console.error(
  `\nIf any of these is real: rotate it at the vendor first, then remove it from the repository.` +
    `\nRotating is the part that matters — a key that has been pushed is a key somebody else may already hold.` +
    `\nIf it is a placeholder, add it to ALLOWED in scripts/scan-secrets.mjs.\n`,
);
process.exit(1);
