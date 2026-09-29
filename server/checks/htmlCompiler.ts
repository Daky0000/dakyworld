import assert from "node:assert/strict";
import {
  compileClaudeDynamicTemplate,
  prepareImportedHtml,
} from "../src/services/htmlCompiler.js";

// Test 1: Template with DCLogic and renderVals
const templateWithDcLogic = `
<!DOCTYPE html>
<html>
<head><title>Test DC</title></head>
<body>
<x-dc>
<header>
  <sc-if value="{{ wide }}">
    <nav><a href="#services">Services</a></nav>
  </sc-if>
</header>
<main>
  <h1>{{ slide.pre }}<em>{{ slide.em }}</em>{{ slide.post }}</h1>
  <p>{{ slide.desc }}</p>
  <div class="chips">
    <sc-for list="{{ chips }}" as="c">
      <button sc-camel-on-click="{{ c.pick }}">{{ c.label }}</button>
    </sc-for>
  </div>
  <sc-if value="{{ showEvents }}">
    <div class="events">
      <sc-for list="{{ events }}" as="e">
        <div class="event-card">
          <span>{{ e.date }}</span>
          <h3>{{ e.title }}</h3>
        </div>
      </sc-for>
    </div>
  </sc-if>
</main>
</x-dc>
<script type="text/x-dc" data-dc-script="">
class Component extends DCLogic {
  state = { w: 1280, slide: 0 };
  slides = [
    { pre: "Make AI ", em: "useful", post: " for your business.", desc: "Practical AI systems." }
  ];
  renderVals() {
    return {
      slide: this.slides[0],
      wide: true,
      showEvents: true,
      chips: [{ label: "Audit" }, { label: "Train" }],
      events: [
        { date: "Oct 22", title: "AI Masterclass" },
        { date: "Nov 15", title: "Automation Sprint" }
      ]
    };
  }
}
</script>
</body>
</html>
`;

const compiled1 = compileClaudeDynamicTemplate(templateWithDcLogic);
assert.equal(compiled1.includes("Make AI <em>useful</em> for your business."), true);
assert.equal(compiled1.includes("Practical AI systems."), true);
assert.equal(compiled1.includes("Audit"), true);
assert.equal(compiled1.includes("Train"), true);
assert.equal(compiled1.includes("AI Masterclass"), true);
assert.equal(compiled1.includes("Automation Sprint"), true);
assert.equal(compiled1.includes("<x-dc"), false);
assert.equal(compiled1.includes("</x-dc>"), false);
assert.equal(compiled1.includes("<sc-for"), false);
assert.equal(compiled1.includes("<sc-if"), false);
assert.equal(compiled1.includes("{{ slide.pre }}"), false);
assert.equal(compiled1.includes("text/x-dc"), false);
assert.equal(compiled1.includes("sc-camel-on-click"), false);

// Test 2: Regular HTML is completely preserved untouched
const regularHtml = `<!DOCTYPE html><html><head><title>Plain</title></head><body><h1>Hello World</h1><p>Test</p></body></html>`;
const compiled2 = compileClaudeDynamicTemplate(regularHtml);
assert.equal(compiled2, regularHtml);

// Test 3: prepareImportedHtml handles plain and template HTML
const preparedRegular = prepareImportedHtml(regularHtml);
assert.equal(preparedRegular, regularHtml);

const preparedTemplate = prepareImportedHtml(templateWithDcLogic);
assert.equal(preparedTemplate.includes("Make AI <em>useful</em> for your business."), true);
assert.equal(preparedTemplate.includes("{{ slide.pre }}"), false);

console.log("htmlCompiler checks passed: dynamic component hydration, template interpolation, bundle cleanup, and regular HTML preservation.");
