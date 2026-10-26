import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatEmailBodyToHtml, EMAIL_SHORTCODES } from "../lib/emailBodyParser";

export interface EmailBodyEditorProps {
  value: string;
  onChange: (value: string) => void;
  variables?: Record<string, string>;
  placeholder?: string;
  rows?: number;
  className?: string;
  /** Quick link suggestions (e.g. demo URL, website) */
  quickLinks?: { label: string; url: string }[];
}

export function EmailBodyEditor({
  value,
  onChange,
  variables = {},
  placeholder = "Write your message... Blank line between paragraphs.",
  rows = 14,
  className = "",
  quickLinks = [],
}: EmailBodyEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Popovers & Dialog states
  const [showHighlightMenu, setShowHighlightMenu] = useState(false);
  const [showCalloutMenu, setShowCalloutMenu] = useState(false);
  const [showButtonModal, setShowButtonModal] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showLivePreview, setShowLivePreview] = useState(false);

  // Button Modal form state
  const [btnLabel, setBtnLabel] = useState("");
  const [btnHref, setBtnHref] = useState("");
  const [btnBg, setBtnBg] = useState("#2563EB");
  const [btnAlign, setBtnAlign] = useState<"left" | "center">("left");

  // Link Modal form state
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");

  /**
   * Helper to wrap selected text in the textarea, or insert placeholder text
   * at the current cursor position if nothing is selected.
   */
  const wrapSelection = (before: string, after: string, defaultPlaceholder = "text") => {
    const el = textareaRef.current;
    if (!el) {
      onChange(`${value}${before}${defaultPlaceholder}${after}`);
      return;
    }

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);
    const replacement = selected ? `${before}${selected}${after}` : `${before}${defaultPlaceholder}${after}`;

    const nextValue = value.slice(0, start) + replacement + value.slice(end);
    onChange(nextValue);

    setTimeout(() => {
      el.focus();
      if (selected) {
        // Keep wrapped text selected or place cursor after
        el.setSelectionRange(start + before.length, start + before.length + selected.length);
      } else {
        // Select placeholder text so user can immediately type over it
        el.setSelectionRange(start + before.length, start + before.length + defaultPlaceholder.length);
      }
    }, 10);
  };

  /** Inserts text or snippet directly at the cursor or at end of selection. */
  const insertText = (snippet: string) => {
    const el = textareaRef.current;
    if (!el) {
      onChange(value ? `${value}\n\n${snippet}` : snippet);
      return;
    }

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const nextValue = value.slice(0, start) + snippet + value.slice(end);
    onChange(nextValue);

    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    }, 10);
  };

  /** Prepends a marker (e.g. `## `, `- `, `1. `) to the current line. */
  const prefixCurrentLine = (prefix: string) => {
    const el = textareaRef.current;
    if (!el) return;

    const start = el.selectionStart;
    const beforeCursor = value.slice(0, start);
    const lineStart = beforeCursor.lastIndexOf("\n") + 1;
    const nextValue = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    onChange(nextValue);

    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + prefix.length, start + prefix.length);
    }, 10);
  };

  // Keyboard shortcut handler
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const isMeta = e.ctrlKey || e.metaKey;
    if (!isMeta) {
      if (e.key === "Tab") {
        e.preventDefault();
        insertText("  ");
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case "b":
        e.preventDefault();
        wrapSelection("**", "**", "bold text");
        break;
      case "i":
        e.preventDefault();
        wrapSelection("*", "*", "italic text");
        break;
      case "u":
        e.preventDefault();
        wrapSelection("<u>", "</u>", "underlined text");
        break;
      case "k":
        e.preventDefault();
        openLinkModal();
        break;
      case "h":
        e.preventDefault();
        wrapSelection("[highlight]", "[/highlight]", "highlighted paragraph");
        break;
    }
  };

  const openLinkModal = () => {
    const el = textareaRef.current;
    const selected = el ? value.slice(el.selectionStart, el.selectionEnd) : "";
    setLinkText(selected || "link text");
    setLinkUrl("https://");
    setShowLinkModal(true);
  };

  const confirmLink = () => {
    if (!linkUrl.trim()) return;
    const cleanUrl = linkUrl.trim();
    const cleanLabel = linkText.trim() || cleanUrl;
    insertText(`[${cleanLabel}](${cleanUrl})`);
    setShowLinkModal(false);
  };

  const openButtonModal = () => {
    const el = textareaRef.current;
    const selected = el ? value.slice(el.selectionStart, el.selectionEnd) : "";
    setBtnLabel(selected || "Open Prototype");
    setBtnHref("https://");
    setBtnBg("#2563EB");
    setBtnAlign("left");
    setShowButtonModal(true);
  };

  const confirmButton = () => {
    if (!btnHref.trim()) return;
    const label = btnLabel.trim() || "Click Here";
    const href = btnHref.trim();
    const alignAttr = btnAlign === "center" ? ' align="center"' : "";
    const bgAttr = btnBg !== "#2563EB" ? ` bg="${btnBg}"` : "";
    insertText(`\n\n[button href="${href}"${bgAttr}${alignAttr}]${label}[/button]\n\n`);
    setShowButtonModal(false);
  };

  // Render client live preview HTML
  const livePreviewHtml = formatEmailBodyToHtml(value);

  return (
    <div className={`relative ${className}`}>
      {/* --- Toolbar Header --- */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-t-xl border border-b-0 border-line bg-sunken/60 px-2.5 py-1.5 text-xs">
        {/* Formatting actions */}
        <div className="flex flex-wrap items-center gap-1">
          {/* Bold */}
          <ToolbarButton
            title="Bold (Ctrl+B)"
            onClick={() => wrapSelection("**", "**", "bold text")}
          >
            <span className="font-bold">B</span>
          </ToolbarButton>

          {/* Italic */}
          <ToolbarButton
            title="Italic (Ctrl+I)"
            onClick={() => wrapSelection("*", "*", "italic text")}
          >
            <span className="italic">I</span>
          </ToolbarButton>

          {/* Underline */}
          <ToolbarButton
            title="Underline (Ctrl+U)"
            onClick={() => wrapSelection("<u>", "</u>", "underlined text")}
          >
            <span className="underline">U</span>
          </ToolbarButton>

          {/* Strikethrough */}
          <ToolbarButton
            title="Strikethrough"
            onClick={() => wrapSelection("~~", "~~", "struck text")}
          >
            <span className="line-through">S</span>
          </ToolbarButton>

          <ToolbarDivider />

          {/* Headings */}
          <ToolbarButton
            title="Heading 2 (## )"
            onClick={() => prefixCurrentLine("## ")}
          >
            <span className="font-semibold">H2</span>
          </ToolbarButton>
          <ToolbarButton
            title="Heading 3 (### )"
            onClick={() => prefixCurrentLine("### ")}
          >
            <span className="font-semibold text-[11px]">H3</span>
          </ToolbarButton>

          <ToolbarDivider />

          {/* Bullet List */}
          <ToolbarButton
            title="Bullet list"
            onClick={() => prefixCurrentLine("- ")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"></line>
              <line x1="8" y1="12" x2="21" y2="12"></line>
              <line x1="8" y1="18" x2="21" y2="18"></line>
              <line x1="3" y1="6" x2="3.01" y2="6"></line>
              <line x1="3" y1="12" x2="3.01" y2="12"></line>
              <line x1="3" y1="18" x2="3.01" y2="18"></line>
            </svg>
          </ToolbarButton>

          {/* Numbered List */}
          <ToolbarButton
            title="Numbered list"
            onClick={() => prefixCurrentLine("1. ")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="10" y1="6" x2="21" y2="6"></line>
              <line x1="10" y1="12" x2="21" y2="12"></line>
              <line x1="10" y1="18" x2="21" y2="18"></line>
              <path d="M4 6h1v4"></path>
              <path d="M4 10h2"></path>
              <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path>
            </svg>
          </ToolbarButton>

          {/* Quote */}
          <ToolbarButton
            title="Quote"
            onClick={() => wrapSelection("[quote]", "[/quote]", "Quoted message")}
          >
            <span className="font-serif text-sm leading-none">“</span>
          </ToolbarButton>

          {/* Code */}
          <ToolbarButton
            title="Inline Code / Block"
            onClick={() => wrapSelection("[code]", "[/code]", "code snippet")}
          >
            <span className="font-mono text-[11px]">&lt;/&gt;</span>
          </ToolbarButton>

          {/* Link */}
          <ToolbarButton title="Insert Link (Ctrl+K)" onClick={openLinkModal}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
            </svg>
          </ToolbarButton>

          <ToolbarDivider />

          {/* Shortcode: Highlight */}
          <div className="relative inline-block">
            <button
              type="button"
              title="Highlight text or paragraph [highlight]"
              onClick={() => setShowHighlightMenu(!showHighlightMenu)}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-300/60 bg-amber-100/60 px-2 py-1 font-sans text-[11px] font-medium text-amber-900 transition hover:bg-amber-200/70"
            >
              <span className="h-2 w-2 rounded-full bg-amber-400"></span>
              Highlight
              <span className="text-[9px] opacity-60">▼</span>
            </button>

            {showHighlightMenu && (
              <div className="absolute left-0 top-full z-20 mt-1 w-44 rounded-xl border border-line bg-white p-1.5 shadow-lg">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted font-medium">Highlight Color</div>
                {[
                  { label: "Yellow (Warm)", color: "yellow", bg: "#FEF08A" },
                  { label: "Blue (Primary)", color: "blue", bg: "#DBEAFE" },
                  { label: "Green (Mint)", color: "green", bg: "#DCFCE7" },
                  { label: "Amber (Orange)", color: "amber", bg: "#FFEDD5" },
                  { label: "Purple", color: "purple", bg: "#F3E8FF" },
                ].map((item) => (
                  <button
                    key={item.color}
                    type="button"
                    onClick={() => {
                      const tag = item.color === "yellow" ? "[highlight]" : `[highlight color="${item.color}"]`;
                      wrapSelection(tag, "[/highlight]", "highlighted text");
                      setShowHighlightMenu(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-ink hover:bg-sunken"
                  >
                    <span className="h-3 w-3 rounded-full border border-black/10" style={{ backgroundColor: item.bg }}></span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Shortcode: Callout Box */}
          <div className="relative inline-block">
            <button
              type="button"
              title="Add highlighted callout box [callout]"
              onClick={() => setShowCalloutMenu(!showCalloutMenu)}
              className="inline-flex items-center gap-1 rounded-lg border border-blue/40 bg-blue/10 px-2 py-1 font-sans text-[11px] font-medium text-blue transition hover:bg-blue/20"
            >
              <span>💬</span>
              Callout Box
              <span className="text-[9px] opacity-60">▼</span>
            </button>

            {showCalloutMenu && (
              <div className="absolute left-0 top-full z-20 mt-1 w-48 rounded-xl border border-line bg-white p-1.5 shadow-lg">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted font-medium">Callout Tone</div>
                {[
                  { tone: "info", label: "Info (Blue)", border: "#2563EB", bg: "#EFF6FF" },
                  { tone: "warning", label: "Warning (Amber)", border: "#D97706", bg: "#FFFBEB" },
                  { tone: "success", label: "Success (Green)", border: "#16A34A", bg: "#F0FDF4" },
                  { tone: "danger", label: "Urgent Alert (Red)", border: "#DC2626", bg: "#FEF2F2" },
                ].map((item) => (
                  <button
                    key={item.tone}
                    type="button"
                    onClick={() => {
                      const title = item.tone === "warning" ? ' title="Important Notice"' : item.tone === "danger" ? ' title="Urgent Action Required"' : "";
                      const snippet = `\n\n[callout tone="${item.tone}"${title}]\nYour highlighted paragraph or important message goes here.\n[/callout]\n\n`;
                      insertText(snippet);
                      setShowCalloutMenu(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink hover:bg-sunken"
                  >
                    <span className="h-3.5 w-3.5 rounded border-l-2" style={{ backgroundColor: item.bg, borderLeftColor: item.border }}></span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Shortcode: Button CTA */}
          <button
            type="button"
            title="Insert CTA Action Button [button]"
            onClick={openButtonModal}
            className="inline-flex items-center gap-1 rounded-lg border border-ink/20 bg-ink px-2.5 py-1 font-sans text-[11px] font-medium text-white transition hover:bg-[#1E2A44]"
          >
            <span>🔘</span>
            Button CTA
          </button>

          {/* Badge */}
          <ToolbarButton
            title="Inline Badge [badge]"
            onClick={() => wrapSelection('[badge tone="green"]', "[/badge]", "Active")}
          >
            <span className="rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-semibold text-emerald-800">Badge</span>
          </ToolbarButton>

          {/* Divider */}
          <ToolbarButton
            title="Horizontal Divider [divider]"
            onClick={() => insertText("\n\n[divider]\n\n")}
          >
            <span className="font-mono text-xs">―</span>
          </ToolbarButton>
        </div>

        {/* View & Guide Actions */}
        <div className="flex items-center gap-1.5">
          {/* Live Preview Toggle */}
          <button
            type="button"
            onClick={() => setShowLivePreview(!showLivePreview)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-sans text-[11px] font-medium transition ${
              showLivePreview
                ? "border-blue bg-blue text-white"
                : "border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
            }`}
            title="Toggle Live Preview in Write view"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <span>{showLivePreview ? "Previewing" : "Live Preview"}</span>
          </button>

          {/* Guide Toggle */}
          <button
            type="button"
            onClick={() => setShowGuide(!showGuide)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-sans text-[11px] transition ${
              showGuide
                ? "border-ink bg-ink text-white"
                : "border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
            }`}
            title="Formatting & Shortcode Cheatsheet"
          >
            <span>💡</span>
            <span>Guide</span>
          </button>
        </div>
      </div>

      {/* --- Expandable Formatting & Shortcode Guide --- */}
      {showGuide && (
        <div className="border border-b-0 border-line bg-white p-3.5 text-xs text-ink transition-all">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-sans text-[11px] font-semibold uppercase tracking-wider text-muted">
              Email Shortcodes, HTML & Variables Guide
            </span>
            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="text-xs text-muted hover:text-ink"
            >
              ✕ Close
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Shortcodes */}
            <div className="rounded-xl border border-line bg-sunken/40 p-2.5">
              <div className="mb-1 font-semibold text-blue">Shortcodes</div>
              <ul className="space-y-1.5 text-[11px]">
                {EMAIL_SHORTCODES.map((sc) => (
                  <li key={sc.name} className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-mono text-ink">[{sc.name}]</span>
                      <span className="ml-1 text-muted">({sc.label})</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => insertText(sc.snippet)}
                      className="rounded border border-line bg-white px-1.5 py-0.5 text-[10px] text-muted hover:border-ink hover:text-ink"
                    >
                      + Insert
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {/* Direct HTML Code */}
            <div className="rounded-xl border border-line bg-sunken/40 p-2.5">
              <div className="mb-1 font-semibold text-blue">HTML Code Support</div>
              <p className="mb-1.5 text-[11px] text-muted">
                You can write or paste standard HTML inside the email content. All safe formatting tags and inline styles are preserved:
              </p>
              <div className="flex flex-wrap gap-1 font-mono text-[10px]">
                {[
                  { tag: "<b>bold</b>", snippet: "<b>bold text</b>" },
                  { tag: "<i>italic</i>", snippet: "<i>italic text</i>" },
                  { tag: "<u>underline</u>", snippet: "<u>underlined text</u>" },
                  { tag: '<a href="...">', snippet: '<a href="https://example.com" style="color:#2563EB;">link</a>' },
                  { tag: "<h3>Heading</h3>", snippet: '<h3 style="font-size:18px;font-weight:600;">Title</h3>' },
                  { tag: "<table>", snippet: '<table style="margin:16px 0;"><tr><td>Cell</td></tr></table>' },
                ].map((item) => (
                  <button
                    key={item.tag}
                    type="button"
                    onClick={() => insertText(item.snippet)}
                    className="rounded border border-line bg-white px-1.5 py-0.5 text-muted hover:border-ink hover:text-ink"
                  >
                    {item.tag}
                  </button>
                ))}
              </div>
            </div>

            {/* Variables & Markdown */}
            <div className="rounded-xl border border-line bg-sunken/40 p-2.5">
              <div className="mb-1 font-semibold text-blue">Variables & Markdown</div>
              <p className="mb-1.5 text-[11px] text-muted">
                Markdown (<code>**bold**</code>, <code>*italic*</code>, <code>- list</code>) and placeholders fill automatically:
              </p>
              <div className="flex flex-wrap gap-1">
                {Object.keys(variables).length > 0 ? (
                  Object.entries(variables).map(([name, val]) => (
                    <button
                      key={name}
                      type="button"
                      title={val || "(empty)"}
                      onClick={() => insertText(`{{${name}}}`)}
                      className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[10px] text-muted hover:border-ink hover:text-ink"
                    >
                      {`{{${name}}}`}
                    </button>
                  ))
                ) : (
                  <span className="text-[11px] text-muted">Pick a recipient to see available placeholders.</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- Main Textarea Input --- */}
      <textarea
        ref={textareaRef}
        rows={rows}
        className={`input font-normal leading-relaxed ${showLivePreview ? "rounded-none border-b-0" : "rounded-t-none"} focus:ring-1`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      {/* --- Live Preview Box (Toggled) --- */}
      {showLivePreview && (
        <div className="rounded-b-xl border border-line bg-white p-4 shadow-inner">
          <div className="mb-2 flex items-center justify-between border-b border-line pb-2">
            <span className="font-sans text-[11px] font-semibold uppercase tracking-wider text-muted">
              Live Content Preview
            </span>
            <span className="text-[11px] text-muted">Renders HTML, shortcodes & markdown</span>
          </div>

          <div
            className="prose prose-sm max-w-none text-ink"
            style={{
              fontFamily: "'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
              fontSize: "15px",
              lineHeight: "26px",
            }}
            dangerouslySetInnerHTML={{ __html: livePreviewHtml || "<p class='text-muted italic'>Start typing above to see live preview...</p>" }}
          />
        </div>
      )}

      {/* --- Button CTA Modal --- */}
      {showButtonModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-ink">Insert Email CTA Button</h3>
              <button
                type="button"
                onClick={() => setShowButtonModal(false)}
                className="text-muted hover:text-ink"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3.5">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Button Label</label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. Open Interactive Prototype"
                  value={btnLabel}
                  onChange={(e) => setBtnLabel(e.target.value)}
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Destination Link (URL)</label>
                <input
                  type="text"
                  className="input font-mono text-xs"
                  placeholder="https://..."
                  value={btnHref}
                  onChange={(e) => setBtnHref(e.target.value)}
                />
              </div>

              {quickLinks.length > 0 && (
                <div>
                  <span className="text-[11px] text-muted">Suggestions:</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {quickLinks.map((link) => (
                      <button
                        key={link.url}
                        type="button"
                        onClick={() => {
                          setBtnHref(link.url);
                          if (!btnLabel) setBtnLabel(link.label);
                        }}
                        className="rounded border border-line bg-cream px-2 py-0.5 text-xs text-muted hover:border-ink hover:text-ink"
                      >
                        {link.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted">Button Color</label>
                  <div className="flex items-center gap-1.5">
                    {[
                      { label: "Primary Blue", hex: "#2563EB" },
                      { label: "Navy Ink", hex: "#091833" },
                      { label: "Emerald", hex: "#16A34A" },
                      { label: "Amber", hex: "#D97706" },
                    ].map((c) => (
                      <button
                        key={c.hex}
                        type="button"
                        title={c.label}
                        onClick={() => setBtnBg(c.hex)}
                        className={`h-6 w-6 rounded-full border-2 transition ${
                          btnBg === c.hex ? "border-ink scale-110" : "border-transparent"
                        }`}
                        style={{ backgroundColor: c.hex }}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted">Alignment</label>
                  <div className="flex gap-1.5">
                    {(["left", "center"] as const).map((align) => (
                      <button
                        key={align}
                        type="button"
                        onClick={() => setBtnAlign(align)}
                        className={`rounded-lg border px-2.5 py-1 text-xs capitalize transition ${
                          btnAlign === align ? "border-ink bg-ink text-white" : "border-line bg-white text-muted hover:text-ink"
                        }`}
                      >
                        {align}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Preview Button */}
              <div className="rounded-xl border border-line bg-sunken/40 p-3 text-center">
                <span className="text-[10px] uppercase tracking-wider text-muted font-medium block mb-2">Live Button Preview</span>
                <div style={{ textAlign: btnAlign }}>
                  <span
                    style={{
                      display: "inline-block",
                      backgroundColor: btnBg,
                      color: "#FFFFFF",
                      padding: "10px 20px",
                      borderRadius: "6px",
                      fontWeight: 600,
                      fontSize: "14px",
                    }}
                  >
                    {btnLabel || "Button Preview"}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowButtonModal(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmButton}
                disabled={!btnHref.trim()}
                className="rounded-lg bg-blue px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-d disabled:opacity-50"
              >
                Insert Button
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- Link Modal --- */}
      {showLinkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-line bg-white p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-ink">Insert Link</h3>
              <button
                type="button"
                onClick={() => setShowLinkModal(false)}
                className="text-muted hover:text-ink"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Link Text</label>
                <input
                  type="text"
                  className="input"
                  value={linkText}
                  onChange={(e) => setLinkText(e.target.value)}
                  placeholder="e.g. view our website"
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Target URL</label>
                <input
                  type="text"
                  className="input font-mono text-xs"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowLinkModal(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmLink}
                disabled={!linkUrl.trim()}
                className="rounded-lg bg-ink px-4 py-1.5 text-xs font-medium text-white hover:bg-[#1E2A44] disabled:opacity-50"
              >
                Insert Link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-transparent px-1.5 font-sans text-xs text-muted transition hover:border-line hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue"
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <span className="h-4 w-px bg-line" aria-hidden="true" />;
}
