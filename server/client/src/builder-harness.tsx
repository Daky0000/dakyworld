import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { WebsiteEditor } from "./pages/WebsiteEditor";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebsiteQuickStart } from "./components/WebsiteQuickStart";
import { WebsiteImageFraming } from "./components/WebsiteImageFraming";
import { WebsitePresetPicker, WebsitePresetRollout, WebsitePresetSettings } from "./components/WebsiteBrandPresets";
import { PublishProgress, type PublishJobStatus } from "./components/PublishStatus";
import { ElementInspector } from "./components/ElementInspector";
import type { BrandPreset } from "./lib/websiteBrandPresets";
import "./index.css";
import { InteractionHarness } from "./interaction-harness";

function Harness() {
  const [guide, setGuide] = useState(true);
  const [style, setStyle] = useState("");
  const [simple, setSimple] = useState(true);
  const [presets, setPresets] = useState<BrandPreset[]>([{ id: "primary", name: "Primary button", target: "button", styles: { "background-color": "#3157ff", padding: "12px 24px" } }]);
  const [state, setState] = useState<PublishJobStatus["state"]>("VERIFYING");
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <h1 className="text-2xl font-semibold">Website builder · editing controls</h1>
    {guide && <WebsiteQuickStart onClose={() => setGuide(false)} />}
    <div className="grid gap-6 md:grid-cols-2"><section className="rounded-xl border border-line bg-white p-4"><h2 className="mb-3 text-lg">Client editing</h2><label><input type="checkbox" checked={!simple} onChange={e => setSimple(!e.target.checked)} /> Designer controls</label><WebsitePresetPicker presets={presets} kind="button" tag="a" style={style} onApply={setStyle} /><ElementInspector simple={simple} facts={{ kind: "button", tag: "a", display: "inline-block", parentDisplay: "block", position: "static", hasText: true, childCount: 0 }} device="desktop" style={style} source={{ sourceStyle: "", baseStyle: "", computed: {} }} onChange={setStyle} onReset={() => setStyle("")} content={<label>Button text<input aria-label="Button text" defaultValue="Get started" /></label>} /><output data-testid="style" className="block break-words text-xs">{style}</output></section>
    <section className="rounded-xl border border-line bg-white p-4"><h2 className="mb-3 text-lg">Image framing</h2><WebsiteImageFraming src="/builder-fixture.svg" style={style} onApply={setStyle} /></section></div>
    <label>Publishing state<select aria-label="Publishing state" value={state} onChange={e => setState(e.target.value as PublishJobStatus["state"])}>{["QUEUED", "VERIFYING", "COMPLETED", "VERIFY_FAILED", "COMMIT_FAILED", "RECONCILIATION_REQUIRED"].map(value => <option key={value}>{value}</option>)}</select></label>
    <PublishProgress status={{ id: "job", state, label: state, verifyUrl: "https://example.com/", attempts: 0, lastError: null, deployedInSeconds: null }} />
    <WebsitePresetSettings presets={presets} onChange={setPresets} />
    <WebsitePresetRollout siteId="demo" presets={presets} disabled={false} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{new URLSearchParams(location.search).has("editor") ? <MemoryRouter initialEntries={["/website/pages/one"]}><AuthProvider><Routes><Route path="/website/pages/:pageId" element={<WebsiteEditor />} /></Routes></AuthProvider></MemoryRouter> : <BrowserRouter>{new URLSearchParams(location.search).has("interaction") ? <InteractionHarness /> : <Harness />}</BrowserRouter>}</QueryClientProvider></React.StrictMode>);
