import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WebsiteStyleTab, type StyleFacts } from "./components/WebsiteStyleTab";
import "./index.css";

/**
 * A throwaway mount for the Style tab, so a browser can be asked what it drew.
 *
 * Not part of the app and not referenced by it. `checks/browser/inspector.mjs`
 * drives this page; the rest of the editor needs a database, a site and a
 * published page before it will show a panel at all, and none of that is under
 * test here. The style is held here, so a change shows in the panel the way it
 * does in the editor.
 */
declare global {
  interface Window {
    __harness: { writes: string[]; select: (name: string) => void };
  }
}

/** Set by the component on its first render; the only way in from the driver. */
let choose: (name: string) => void = () => {};

type Case = {
  facts: StyleFacts;
  style?: string;
  sourceStyle?: string;
  inheritedStyle?: string;
  device?: "desktop" | "tablet" | "mobile";
  computed: Record<string, string>;
};

const CASES: Record<string, Case> = {
  heading: {
    facts: { kind: "text", tag: "h1", display: "block", parentDisplay: "block", position: "static" },
    computed: { "font-size": "72px", "font-family": '"Space Grotesk", sans-serif', "font-weight": "700", color: "rgb(8, 16, 31)", "line-height": "75.6px", "max-width": "780px", position: "static", opacity: "1", "z-index": "auto", display: "block" },
  },
  image: {
    facts: { kind: "image", tag: "img", display: "block", parentDisplay: "block", position: "static" },
    computed: { "object-fit": "cover", "object-position": "50% 50%", width: "540px", height: "360px", "border-top-left-radius": "24px", display: "block" },
  },
  flexRow: {
    facts: { kind: "container", tag: "div", display: "flex", parentDisplay: "block", position: "static" },
    computed: { display: "flex", "flex-direction": "row", "row-gap": "24px", "column-gap": "24px", "justify-content": "space-between", "flex-wrap": "nowrap" },
  },
  gridWrap: {
    facts: { kind: "container", tag: "section", display: "grid", parentDisplay: "block", position: "static" },
    computed: { display: "grid", "grid-template-columns": "320px 320px 320px", "row-gap": "32px" },
  },
  flexChild: {
    facts: { kind: "text", tag: "p", display: "block", parentDisplay: "flex", position: "static" },
    computed: { "font-size": "16px", "align-self": "auto", "flex-grow": "0", display: "block" },
  },
  gridChild: {
    facts: { kind: "text", tag: "p", display: "block", parentDisplay: "grid", position: "static" },
    computed: { "font-size": "16px", "grid-column": "span 2", display: "block" },
  },
  overlay: {
    facts: { kind: "container", tag: "div", display: "block", parentDisplay: "block", position: "absolute" },
    computed: { position: "absolute", top: "0px", left: "0px", "z-index": "3", display: "block" },
  },
  edited: {
    facts: { kind: "text", tag: "h1", display: "block", parentDisplay: "block", position: "static" },
    style: "font-size: 64px",
    sourceStyle: "",
    computed: { "font-size": "64px", color: "rgb(8, 16, 31)", display: "block" },
  },
  developerInline: {
    facts: { kind: "text", tag: "h1", display: "block", parentDisplay: "block", position: "static" },
    style: "font-size: 60px; margin: 0 auto",
    sourceStyle: "font-size: 60px; margin: 0 auto",
    computed: { "font-size": "60px", display: "block" },
  },
  tablet: {
    facts: { kind: "text", tag: "h2", display: "block", parentDisplay: "block", position: "static" },
    device: "tablet",
    style: "",
    inheritedStyle: "font-size: 48px",
    computed: { "font-size": "48px", display: "block" },
  },
  layered: {
    facts: { kind: "container", tag: "section", display: "block", parentDisplay: "block", position: "static" },
    style: "background: url('/hero.jpg') center/cover no-repeat, #0D1526; box-shadow: 0 2px 8px rgba(0,0,0,.12), inset 0 1px 0 #fff; transform: translate(10px, 0px) rotate(5deg); filter: blur(2px); text-shadow: 0 1px 2px #0003",
    sourceStyle: "background: url('/hero.jpg') center/cover no-repeat, #0D1526; box-shadow: 0 2px 8px rgba(0,0,0,.12), inset 0 1px 0 #fff; transform: translate(10px, 0px) rotate(5deg); filter: blur(2px); text-shadow: 0 1px 2px #0003",
    computed: { display: "block" },
  },
  developerTransform: {
    facts: { kind: "container", tag: "div", display: "block", parentDisplay: "block", position: "static" },
    style: "transform: matrix(1, 0, 0, 1, 10, 0)",
    sourceStyle: "transform: matrix(1, 0, 0, 1, 10, 0)",
    computed: { display: "block" },
  },
};

function Harness() {
  const [name, setName] = useState("heading");
  const [styles, setStyles] = useState<Record<string, string>>({});
  choose = setName;
  const active = CASES[name]!;
  const style = styles[name] ?? active.style ?? "";
  return (
    <div className="website-editor dx-editor" style={{ width: 316 }}>
      <div data-testid="case">{name}</div>
      <WebsiteStyleTab
        key={name}
        style={style}
        sourceStyle={active.sourceStyle ?? ""}
        inheritedStyle={active.inheritedStyle ?? ""}
        computed={active.computed}
        facts={active.facts}
        device={active.device ?? "desktop"}
        fonts={["Space Grotesk", "Inter"]}
        readOnly={false}
        designer
        onChange={(next) => {
          window.__harness.writes.push(next);
          setStyles((current) => ({ ...current, [name]: next }));
        }}
        onCommit={() => {}}
        onPickImage={(apply) => apply("/picked.jpg")}
      />
    </div>
  );
}

window.__harness = { writes: [], select: (next: string) => choose(next) };

createRoot(document.getElementById("root")!).render(<Harness />);
