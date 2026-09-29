import assert from "node:assert/strict";
import { extractColorsFromHtml, normaliseToHex6 } from "../src/services/website/pageColors.js";

let checks = 0;
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  checks += 1;
};
const equal = (name: string, actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected, name);
  checks += 1;
};

// 1. normaliseToHex6
equal("normalise 3-digit hex", normaliseToHex6("#f06"), "#FF0066");
equal("normalise 6-digit hex", normaliseToHex6("#3157ff"), "#3157FF");
equal("normalise 8-digit hex", normaliseToHex6("#ff5722cc"), "#FF5722");
equal("normalise rgb", normaliseToHex6("rgb(255, 87, 34)"), "#FF5722");
equal("normalise rgba", normaliseToHex6("rgba(0, 188, 212, 0.9)"), "#00BCD4");
equal("transparent is null", normaliseToHex6("transparent"), null);
equal("zero alpha rgba is null", normaliseToHex6("rgba(0, 0, 0, 0)"), null);
equal("named white", normaliseToHex6("white"), "#FFFFFF");
equal("named black", normaliseToHex6("black"), "#000000");

// 2. extractColorsFromHtml with complex HTML
const sampleHtml = `
<!doctype html>
<html>
<head>
  <style>
    :root {
      --brand-primary: #FF5722;
      --brand-accent: #00BCD4;
      --site-bg: #FAFAFA;
      --site-ink: #212121;
    }
    body {
      background-color: var(--site-bg);
      color: var(--site-ink);
    }
    .hero {
      background: linear-gradient(135deg, var(--brand-primary), #E91E63);
      color: #FFFFFF;
    }
    .btn {
      background-color: var(--brand-accent);
      color: rgb(255, 255, 255);
      border: 2px solid hsl(187, 100%, 35%);
    }
  </style>
</head>
<body>
  <div style="color: #673AB7; background: rgba(255, 193, 7, 0.8);">
    <svg width="24" height="24" fill="#4CAF50" stroke="#388E3C">
      <path d="..." />
    </svg>
    <p style="color: #212121;">Body text</p>
  </div>
</body>
</html>
`;

const extracted = extractColorsFromHtml(sampleHtml);
console.log("Extracted colours:", extracted);

check("extracted has colours", extracted.length > 0);
check("contains brand primary #FF5722", extracted.includes("#FF5722"));
check("contains brand accent #00BCD4", extracted.includes("#00BCD4"));
check("contains pink #E91E63", extracted.includes("#E91E63"));
check("contains purple #673AB7", extracted.includes("#673AB7"));
check("contains amber #FFC107", extracted.includes("#FFC107"));
check("contains SVG fill #4CAF50", extracted.includes("#4CAF50"));
check("contains white #FFFFFF", extracted.includes("#FFFFFF"));
check("contains ink #212121", extracted.includes("#212121"));

// Check that chromatic brand colours appear before neutrals
const firstChromaticIndex = extracted.findIndex((c) => ["#FF5722", "#00BCD4", "#E91E63", "#673AB7"].includes(c));
const firstNeutralIndex = extracted.findIndex((c) => ["#FFFFFF", "#212121", "#FAFAFA"].includes(c));
check("brand chromatic colours precede neutrals", firstChromaticIndex < firstNeutralIndex);

console.log(`pageColors check passed: ${checks} checks`);
