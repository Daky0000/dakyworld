import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ElementInspector } from "./components/ElementInspector";
import type { ElementFacts } from "./lib/elementInspector";
import "./index.css";

/**
 * A throwaway mount for the inspector, so a browser can be asked what it drew.
 *
 * Not part of the app and not referenced by it. `checks/inspectorBrowser.mjs`
 * drives this page; the rest of the editor needs a database, a site and a
 * published page before it will show a panel at all, and none of that is under
 * test here.
 */
declare global {
  interface Window {
    __harness: { writes: string[]; select: (name: string) => void };
  }
}

/** Set by the component on its first render; the only way in from the driver. */
let choose: (name: string) => void = () => {};

type Case = { facts: ElementFacts; style?: string; sourceStyle?: string; computed: Record<string, string> };

const CASES: Record<string, Case> = {
  heading: {
    facts: { kind: "text", tag: "h1", display: "block", parentDisplay: "block", position: "static", hasText: true, childCount: 0 },
    computed: { "font-size": "72px", "font-family": '"Space Grotesk", sans-serif', "font-weight": "700", color: "rgb(8, 16, 31)", "line-height": "75.6px", "max-width": "780px", position: "static", opacity: "1", "z-index": "auto" },
  },
  image: {
    facts: { kind: "image", tag: "img", display: "block", parentDisplay: "block", position: "static", hasText: false, childCount: 0 },
    computed: { "object-fit": "cover", "object-position": "50% 50%", width: "540px", height: "auto", "border-radius": "24px" },
  },
  flexRow: {
    facts: { kind: "container", tag: "div", display: "flex", parentDisplay: "block", position: "static", hasText: false, childCount: 3 },
    computed: { display: "flex", "flex-direction": "row", "row-gap": "24px", "column-gap": "24px", "justify-content": "space-between" },
  },
  gridWrap: {
    facts: { kind: "container", tag: "section", display: "grid", parentDisplay: "block", position: "static", hasText: false, childCount: 4 },
    computed: { display: "grid", "grid-template-columns": "repeat(3, 1fr)", "row-gap": "32px" },
  },
  flexChild: {
    facts: { kind: "text", tag: "p", display: "block", parentDisplay: "flex", position: "static", hasText: true, childCount: 0 },
    computed: { "font-size": "16px", "align-self": "auto", "flex-grow": "0" },
  },
  gridChild: {
    facts: { kind: "text", tag: "p", display: "block", parentDisplay: "grid", position: "static", hasText: true, childCount: 0 },
    computed: { "font-size": "16px", "grid-column": "span 2" },
  },
  overlay: {
    facts: { kind: "container", tag: "div", display: "block", parentDisplay: "block", position: "absolute", hasText: false, childCount: 1 },
    computed: { position: "absolute", top: "0px", left: "0px", "z-index": "3" },
  },
  sticky: {
    facts: { kind: "container", tag: "header", display: "block", parentDisplay: "block", position: "sticky", hasText: false, childCount: 2 },
    computed: { position: "sticky", top: "0px", "z-index": "10" },
  },
  edited: {
    facts: { kind: "text", tag: "h1", display: "block", parentDisplay: "block", position: "static", hasText: true, childCount: 0 },
    style: "font-size: 64px",
    sourceStyle: "",
    computed: { "font-size": "64px", color: "rgb(8, 16, 31)" },
  },
  developerInline: {
    facts: { kind: "text", tag: "h1", display: "block", parentDisplay: "block", position: "static", hasText: true, childCount: 0 },
    style: "font-size: 60px",
    sourceStyle: "font-size: 60px",
    computed: { "font-size": "60px" },
  },
};

function Harness() {
  const [name, setName] = useState("heading");
  choose = setName;
  const active = CASES[name]!;
  return (
    <div className="w-[300px] border-r border-line bg-white">
      <div data-testid="case">{name}</div>
      <ElementInspector
        key={name}
        facts={active.facts}
        device="desktop"
        style={active.style}
        source={{ sourceStyle: active.sourceStyle ?? "", baseStyle: "", computed: active.computed }}
        palette={["#08101F", "#3157FF", "#B8FF3D"]}
        onChange={(next) => window.__harness.writes.push(next)}
        onReset={() => window.__harness.writes.push("RESET")}
        content={<div data-testid="content-slot">content</div>}
      />
    </div>
  );
}

window.__harness = { writes: [], select: (next: string) => choose(next) };

createRoot(document.getElementById("root")!).render(<Harness />);
