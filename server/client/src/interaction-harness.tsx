import { useState } from "react";
import { WebsiteRichText } from "./components/WebsiteRichText";
import { WebsiteInteractionStyles } from "./components/WebsiteInteractionStyles";
import { formatActiveText } from "./lib/websiteTextSelection";
import { parseStyle } from "./components/InspectorControls";

export function InteractionHarness() {
  const [html, setHtml] = useState('Make your <strong>next idea</strong> real.');
  const [style, setStyle] = useState('color: #000000; background-color: #ffffff');
  const [element, setElement] = useState<HTMLButtonElement | null>(null);
  return <main className="mx-auto max-w-4xl space-y-6 p-6"><h1 className="text-2xl">Text selection and interaction styles</h1>
    <section className="rounded-xl border border-line p-4"><h2 className="mb-3 text-lg">Format selected words</h2><WebsiteRichText html={html} readOnly={false} onChange={setHtml} /><button type="button" onMouseDown={event => event.preventDefault()} onClick={() => formatActiveText({ color: '#008000' })}>Inspector colour shortcut</button><output data-testid="rich-html" className="mt-3 block break-words text-xs">{html}</output></section>
    <section className="grid gap-6 rounded-xl border border-line p-4 sm:grid-cols-2"><WebsiteInteractionStyles element={element} style={style} readOnly={false} onChange={setStyle} /><div><button ref={setElement} data-testid="interaction-button" type="button" className="rounded-xl border p-5" style={Object.fromEntries(Object.entries(parseStyle(style)).map(([key, value]) => [key.startsWith('--') ? key : key.replace(/-([a-z])/g, (_, character) => character.toUpperCase()), value]))}>Start your project</button><output data-testid="interaction-style" className="mt-3 block break-words text-xs">{style}</output></div></section>
    <section aria-label="Read-only text"><WebsiteRichText html="This text cannot be edited." readOnly onChange={() => { throw new Error('Read-only text changed'); }} /></section>
  </main>;
}
