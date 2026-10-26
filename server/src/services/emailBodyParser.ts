/**
 * Email body formatting, shortcode processing, and safe HTML rendering.
 *
 * Supports:
 *  1. Shortcodes:
 *     - `[highlight]text[/highlight]` or `[highlight color="yellow|blue|green|amber|purple"]...[/highlight]`
 *     - `[callout tone="info|warning|success|danger|neutral" title="..."]...[/callout]` (aliases: `[box]`, `[alert]`, `[note]`)
 *     - `[button href="https://..." bg="#2563EB" align="left|center|right"]Button text[/button]`
 *     - `[badge tone="blue|green|amber|red|purple|gray"]text[/badge]`
 *     - `[code]...[/code]` (inline or block)
 *     - `[quote]...[/quote]`
 *     - `[divider]` or `[hr]`
 *  2. Safe HTML tags and attributes for custom markup and email formatting.
 *  3. Markdown shorthand: **bold**, *italic*, ~~strike~~, `code`, ```code blocks```, [links](url), lists, headings.
 *  4. Clean plain-text fallback generation (`toText`).
 */

export const EMAIL_BODY_FONT = "'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const EMAIL_MONO_FONT = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace";
export const EMAIL_ACCENT = "#2563EB";
export const EMAIL_INK = "#0B1528";
export const EMAIL_MUTED = "#5A6578";
export const EMAIL_LINE = "#E5E7EB";

export interface ShortcodeDefinition {
  name: string;
  description: string;
  syntax: string;
  example: string;
}

export const EMAIL_SHORTCODES: ShortcodeDefinition[] = [
  {
    name: "highlight",
    description: "Highlights text or a paragraph with a warm colored background",
    syntax: '[highlight color="yellow|blue|green|amber|purple"]text[/highlight]',
    example: "[highlight]Important observation about your website[/highlight]",
  },
  {
    name: "callout",
    description: "Renders an eye-catching callout card with a left border and tinted background",
    syntax: '[callout tone="info|warning|success|danger|neutral" title="Notice"]Paragraph here[/callout]',
    example: '[callout tone="warning" title="Website Security"]Your SSL certificate expires in 3 days.[/callout]',
  },
  {
    name: "button",
    description: "Creates an email-client bulletproof CTA button",
    syntax: '[button href="https://..." bg="#2563EB" align="left|center"]Button Label[/button]',
    example: '[button href="https://os.dakyx.com/demo/preview/xyz" bg="#2563EB"]View Live Demo[/button]',
  },
  {
    name: "badge",
    description: "Inline status pill badge",
    syntax: '[badge tone="blue|green|amber|red|purple|gray"]Status[/badge]',
    example: '[badge tone="green"]Completed[/badge]',
  },
  {
    name: "code",
    description: "Monospace code block or inline snippet",
    syntax: "[code]snippet[/code]",
    example: "[code]npm run dev[/code]",
  },
  {
    name: "quote",
    description: "Styled blockquote callout",
    syntax: "[quote]Quoted text[/quote]",
    example: "[quote]We saw a 40% increase in inquiries.[/quote]",
  },
  {
    name: "divider",
    description: "Clean horizontal separator rule",
    syntax: "[divider]",
    example: "[divider]",
  },
];

const HIGHLIGHT_COLORS: Record<string, { bg: string; text: string; border?: string }> = {
  yellow: { bg: "#FEF08A", text: "#713F12", border: "#FDE047" },
  blue: { bg: "#DBEAFE", text: "#1E40AF", border: "#BFDBFE" },
  green: { bg: "#DCFCE7", text: "#166534", border: "#BBF7D0" },
  amber: { bg: "#FFEDD5", text: "#9A3412", border: "#FED7AA" },
  orange: { bg: "#FFEDD5", text: "#9A3412", border: "#FED7AA" },
  purple: { bg: "#F3E8FF", text: "#6B21A8", border: "#E9D5FF" },
  pink: { bg: "#FCE7F3", text: "#9D174D", border: "#FBCFE8" },
};

const CALLOUT_TONES: Record<string, { bg: string; border: string; text: string; title: string }> = {
  info: { bg: "#EFF6FF", border: "#2563EB", text: "#1E293B", title: "#1E3A8A" },
  warning: { bg: "#FFFBEB", border: "#D97706", text: "#1E293B", title: "#92400E" },
  success: { bg: "#F0FDF4", border: "#16A34A", text: "#1E293B", title: "#166534" },
  danger: { bg: "#FEF2F2", border: "#DC2626", text: "#1E293B", title: "#991B1B" },
  alert: { bg: "#FEF2F2", border: "#DC2626", text: "#1E293B", title: "#991B1B" },
  purple: { bg: "#FAF5FF", border: "#9333EA", text: "#1E293B", title: "#6B21A8" },
  neutral: { bg: "#F8FAFC", border: "#64748B", text: "#1E293B", title: "#334155" },
};

const BADGE_TONES: Record<string, { bg: string; text: string }> = {
  blue: { bg: "#DBEAFE", text: "#1E40AF" },
  green: { bg: "#DCFCE7", text: "#166534" },
  amber: { bg: "#FEF3C7", text: "#92400E" },
  red: { bg: "#FEE2E2", text: "#991B1B" },
  purple: { bg: "#F3E8FF", text: "#6B21A8" },
  gray: { bg: "#F1F5F9", text: "#334155" },
};

/** Parses shortcode attributes like `color="blue" title="Warning" href='...' align=center`. */
export function parseShortcodeAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(raw)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "true";
    attrs[key] = value;
  }
  return attrs;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeHref(url: string): string {
  const trimmed = url.trim();
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(trimmed)) {
    return trimmed.replace(/"/g, "&quot;");
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) {
    return trimmed.replace(/"/g, "&quot;");
  }
  return "#";
}

/**
 * Sanitizes HTML attributes and tags to ensure security in email clients,
 * while allowing legitimate formatting, styling, tables, buttons, and links.
 */
function sanitizeHtmlString(html: string): string {
  // Strip dangerous tags entirely (content included)
  let clean = html.replace(/<(?:script|style|iframe|object|embed|applet|form|input|textarea|select)[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|embed|applet|form|input|textarea|select)>/gi, "");
  // Strip self-closing or lone dangerous tags
  clean = clean.replace(/<(?:script|style|iframe|object|embed|applet|form|input|textarea|select)[^>]*\/?>/gi, "");

  // Strip dangerous inline event handlers (e.g. onclick=..., onerror=...)
  clean = clean.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Strip javascript: URLs in attributes
  clean = clean.replace(/href\s*=\s*["']?\s*javascript:[^"'>]*/gi, 'href="#"');
  clean = clean.replace(/src\s*=\s*["']?\s*javascript:[^"'>]*/gi, 'src=""');

  return clean;
}

/** Bare URLs become links, skipping URLs that are already inside HTML attributes or <a> tags. */
function linkifyText(text: string): string {
  // Protect existing tags from being linkified inside their attributes
  const parts = text.split(/(<[^>]+>)/g);
  for (let i = 0; i < parts.length; i++) {
    // Only process text between tags, not tags themselves
    if (!parts[i].startsWith("<")) {
      parts[i] = parts[i].replace(/\b(https?:\/\/[^\s<>"']+)/g, (url) => {
        return `<a href="${sanitizeHref(url)}" style="color:${EMAIL_ACCENT};text-decoration:underline;">${url}</a>`;
      });
    }
  }
  return parts.join("");
}

/** Expands shortcodes in the body text into email-friendly HTML structures. */
function processShortcodes(text: string): string {
  let output = text;

  // 1. [callout] / [box] / [alert] / [note]
  const calloutRegex = /\[(callout|box|alert|note)(?:\s+([^\]]*))?\]([\s\S]*?)\[\/\1\]/gi;
  output = output.replace(calloutRegex, (_match, _tag, rawAttrs, content) => {
    const attrs = parseShortcodeAttrs(rawAttrs || "");
    const toneKey = (attrs.tone || attrs.type || "info").toLowerCase();
    const tone = CALLOUT_TONES[toneKey] ?? CALLOUT_TONES.info;
    const title = attrs.title ? attrs.title.trim() : "";
    const inner = content.trim();

    const titleHtml = title
      ? `<strong style="display:block;margin-bottom:6px;font-size:15px;font-weight:600;color:${tone.title};">${escapeHtml(title)}</strong>`
      : "";

    return `\n\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;border-collapse:separate;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td style="background-color:${tone.bg};border-left:4px solid ${tone.border};border-radius:4px;padding:14px 18px;font-family:${EMAIL_BODY_FONT};font-size:14.5px;line-height:24px;color:${tone.text};">${titleHtml}${inner.replace(/\n/g, "<br>")}</td></tr></table>\n\n`;
  });

  // 2. [button] CTA
  // Handles [button href="..."]Text[/button] and self-closing [button href="..." text="..." /]
  const buttonPairRegex = /\[button(?:\s+([^\]]*))?\]([\s\S]*?)\[\/button\]/gi;
  output = output.replace(buttonPairRegex, (_match, rawAttrs, content) => {
    const attrs = parseShortcodeAttrs(rawAttrs || "");
    const href = sanitizeHref(attrs.href || attrs.url || "#");
    const label = (content.trim() || attrs.text || "Click Here").trim();
    const bg = attrs.bg || attrs.color || EMAIL_ACCENT;
    const textColor = attrs.textcolor || attrs.text_color || "#FFFFFF";
    const align = (attrs.align || "left").toLowerCase();
    const alignStyle = align === "center" ? "margin-left:auto;margin-right:auto;" : align === "right" ? "margin-left:auto;" : "";

    return `\n\n<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;${alignStyle}mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td align="center" bgcolor="${bg}" style="border-radius:6px;background-color:${bg};"><a href="${href}" target="_blank" rel="noopener noreferrer" style="font-family:${EMAIL_BODY_FONT};font-size:14.5px;font-weight:600;color:${textColor};text-decoration:none;padding:12px 24px;display:inline-block;border-radius:6px;background-color:${bg};text-align:center;mso-padding-alt:0;"><!--[if mso]><i style="letter-spacing:24px;mso-font-width:-100%;mso-text-raise:18pt">&nbsp;</i><![endif]--><span style="mso-text-raise:9pt;">${escapeHtml(label)}</span><!--[if mso]><i style="letter-spacing:24px;mso-font-width:-100%">&nbsp;</i><![endif]--></a></td></tr></table>\n\n`;
  });

  const buttonSelfClosingRegex = /\[button\s+([^\]]*?)\s*\/?\]/gi;
  output = output.replace(buttonSelfClosingRegex, (_match, rawAttrs) => {
    const attrs = parseShortcodeAttrs(rawAttrs || "");
    const href = sanitizeHref(attrs.href || attrs.url || "#");
    const label = (attrs.text || attrs.label || "Click Here").trim();
    const bg = attrs.bg || attrs.color || EMAIL_ACCENT;
    const textColor = attrs.textcolor || attrs.text_color || "#FFFFFF";
    const align = (attrs.align || "left").toLowerCase();
    const alignStyle = align === "center" ? "margin-left:auto;margin-right:auto;" : align === "right" ? "margin-left:auto;" : "";

    return `\n\n<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;${alignStyle}mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td align="center" bgcolor="${bg}" style="border-radius:6px;background-color:${bg};"><a href="${href}" target="_blank" rel="noopener noreferrer" style="font-family:${EMAIL_BODY_FONT};font-size:14.5px;font-weight:600;color:${textColor};text-decoration:none;padding:12px 24px;display:inline-block;border-radius:6px;background-color:${bg};text-align:center;mso-padding-alt:0;"><!--[if mso]><i style="letter-spacing:24px;mso-font-width:-100%;mso-text-raise:18pt">&nbsp;</i><![endif]--><span style="mso-text-raise:9pt;">${escapeHtml(label)}</span><!--[if mso]><i style="letter-spacing:24px;mso-font-width:-100%">&nbsp;</i><![endif]--></a></td></tr></table>\n\n`;
  });

  // 3. [highlight] / [mark]
  const highlightRegex = /\[(highlight|mark)(?:\s+([^\]]*))?\]([\s\S]*?)\[\/\1\]/gi;
  output = output.replace(highlightRegex, (_match, _tag, rawAttrs, content) => {
    const attrs = parseShortcodeAttrs(rawAttrs || "");
    const colorKey = (attrs.color || attrs.bg || "yellow").toLowerCase();
    const isCustomHex = /^#[0-9a-f]{3,8}$/i.test(colorKey);
    const preset = HIGHLIGHT_COLORS[colorKey] ?? (isCustomHex ? { bg: colorKey, text: "#0F172A", border: colorKey } : HIGHLIGHT_COLORS.yellow);

    const inner = content.trim();
    // If multiline paragraph, render as a highlighted card block
    if (inner.includes("\n\n")) {
      return `\n\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td style="background-color:${preset.bg};border:${preset.border ? `1px solid ${preset.border}` : "none"};border-radius:6px;padding:14px 18px;font-family:${EMAIL_BODY_FONT};font-size:15px;line-height:24px;color:${preset.text};">${inner.replace(/\n/g, "<br>")}</td></tr></table>\n\n`;
    }

    return `<mark style="background-color:${preset.bg};color:${preset.text};padding:2px 6px;border-radius:4px;font-weight:500;font-family:inherit;">${inner}</mark>`;
  });

  // 4. [badge]
  const badgeRegex = /\[badge(?:\s+([^\]]*))?\]([\s\S]*?)\[\/badge\]/gi;
  output = output.replace(badgeRegex, (_match, rawAttrs, content) => {
    const attrs = parseShortcodeAttrs(rawAttrs || "");
    const toneKey = (attrs.tone || attrs.color || "blue").toLowerCase();
    const tone = BADGE_TONES[toneKey] ?? BADGE_TONES.blue;
    return `<span style="display:inline-block;padding:2px 10px;font-size:12px;font-weight:600;border-radius:9999px;background-color:${tone.bg};color:${tone.text};vertical-align:middle;line-height:18px;">${content.trim()}</span>`;
  });

  // 5. [quote]
  const quoteRegex = /\[quote(?:\s+([^\]]*))?\]([\s\S]*?)\[\/quote\]/gi;
  output = output.replace(quoteRegex, (_match, _rawAttrs, content) => {
    return `\n\n<blockquote style="margin:16px 0;padding:10px 18px;border-left:3px solid ${EMAIL_LINE};color:${EMAIL_MUTED};font-style:italic;background-color:#F8FAFC;border-radius:0 4px 4px 0;">${content.trim().replace(/\n/g, "<br>")}</blockquote>\n\n`;
  });

  // 6. [divider] / [hr]
  output = output.replace(/\[(divider|hr)\s*\/?\]/gi, `\n\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td style="border-top:1px solid ${EMAIL_LINE};font-size:0;line-height:0;">&nbsp;</td></tr></table>\n\n`);

  return output;
}

/** Processes markdown formatting in text (bold, italic, strikethrough, headings, lists, quotes). */
function processMarkdown(text: string): string {
  let out = text;

  // Headings: ### H3, ## H2, # H1
  out = out.replace(/^###\s+(.+)$/gm, `<h3 style="font-family:${EMAIL_BODY_FONT};font-size:17px;font-weight:600;line-height:24px;margin:20px 0 10px;color:${EMAIL_INK};">$1</h3>`);
  out = out.replace(/^##\s+(.+)$/gm, `<h2 style="font-family:${EMAIL_BODY_FONT};font-size:20px;font-weight:600;line-height:28px;margin:24px 0 12px;color:${EMAIL_INK};">$1</h2>`);
  out = out.replace(/^#\s+(.+)$/gm, `<h1 style="font-family:${EMAIL_BODY_FONT};font-size:23px;font-weight:700;line-height:30px;margin:28px 0 14px;color:${EMAIL_INK};">$1</h1>`);

  // Bold & Italic markdown
  // Bold: **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__(.+?)__/g, "<strong>$1</strong>");
  // Italic: *text* or _text_
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  out = out.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<em>$1</em>");
  // Strikethrough: ~~text~~
  out = out.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Markdown links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    return `<a href="${sanitizeHref(href)}" style="color:${EMAIL_ACCENT};text-decoration:underline;">${label}</a>`;
  });

  // Markdown blockquote: > text
  out = out.replace(/^>\s+(.+)$/gm, `<blockquote style="margin:16px 0;padding:10px 18px;border-left:3px solid ${EMAIL_LINE};color:${EMAIL_MUTED};font-style:italic;background-color:#F8FAFC;border-radius:0 4px 4px 0;">$1</blockquote>`);

  // Markdown lists:
  // Unordered list: lines starting with "- " or "* "
  out = out.replace(/(?:^[ \t]*[-*][ \t]+.+\n?)+/gm, (listBlock) => {
    const items = listBlock
      .trim()
      .split("\n")
      .map((line) => line.replace(/^[ \t]*[-*][ \t]+/, "").trim())
      .filter(Boolean)
      .map((item) => `<li style="margin:0 0 6px;line-height:24px;">${item}</li>`)
      .join("");
    return `<ul style="margin:14px 0 18px;padding-left:24px;font-family:${EMAIL_BODY_FONT};font-size:15px;color:${EMAIL_INK};">${items}</ul>`;
  });

  // Ordered list: lines starting with "1. ", "2. "
  out = out.replace(/(?:^[ \t]*\d+\.[ \t]+.+\n?)+/gm, (listBlock) => {
    const items = listBlock
      .trim()
      .split("\n")
      .map((line) => line.replace(/^[ \t]*\d+\.[ \t]+/, "").trim())
      .filter(Boolean)
      .map((item) => `<li style="margin:0 0 6px;line-height:24px;">${item}</li>`)
      .join("");
    return `<ol style="margin:14px 0 18px;padding-left:24px;font-family:${EMAIL_BODY_FONT};font-size:15px;color:${EMAIL_INK};">${items}</ol>`;
  });

  return out;
}

const BLOCK_HTML_REGEX = /^(?:<table|<pre|<blockquote|<div|<h[1-6]|<ul|<ol|<hr|<p\b)/i;

/**
 * Transforms an authored email body (with shortcodes, markdown, or raw HTML)
 * into high-fidelity, email-client-compatible HTML.
 */
export function formatEmailBodyToHtml(body: string): string {
  if (!body || !body.trim()) return "";

  // 1. Stash and protect code blocks (both ``` markdown, [code], and <pre><code>)
  const codeBlocks: string[] = [];
  let working = body;

  // Stash ```lang\ncode\n```
  working = working.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gi, (_match, _lang, code) => {
    const token = `\x00CODEBLOCK_${codeBlocks.length}\x00`;
    const escaped = escapeHtml(code.trimEnd());
    codeBlocks.push(
      `<pre style="background-color:#0F172A;color:#F8FAFC;padding:14px 18px;border-radius:6px;font-family:${EMAIL_MONO_FONT};font-size:13px;line-height:1.5;overflow-x:auto;margin:16px 0;border:1px solid #1E293B;"><code>${escaped}</code></pre>`,
    );
    return token;
  });

  // Stash [code]...[/code]
  working = working.replace(/\[code(?:\s+([^\]]*))?\]([\s\S]*?)\[\/code\]/gi, (_match, _rawAttrs, code) => {
    const token = `\x00CODEBLOCK_${codeBlocks.length}\x00`;
    const inner = code.trim();
    if (inner.includes("\n")) {
      const escaped = escapeHtml(inner);
      codeBlocks.push(
        `<pre style="background-color:#0F172A;color:#F8FAFC;padding:14px 18px;border-radius:6px;font-family:${EMAIL_MONO_FONT};font-size:13px;line-height:1.5;overflow-x:auto;margin:16px 0;border:1px solid #1E293B;"><code>${escaped}</code></pre>`,
      );
    } else {
      const escaped = escapeHtml(inner);
      codeBlocks.push(
        `<code style="background-color:#F1F5F9;color:#0F172A;padding:2px 6px;border-radius:4px;font-family:${EMAIL_MONO_FONT};font-size:13px;border:1px solid ${EMAIL_LINE};">${escaped}</code>`,
      );
    }
    return token;
  });

  // Stash inline `code`
  working = working.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `\x00CODEBLOCK_${codeBlocks.length}\x00`;
    const escaped = escapeHtml(code);
    codeBlocks.push(
      `<code style="background-color:#F1F5F9;color:#0F172A;padding:2px 6px;border-radius:4px;font-family:${EMAIL_MONO_FONT};font-size:13px;border:1px solid ${EMAIL_LINE};">${escaped}</code>`,
    );
    return token;
  });

  // 2. Expand shortcodes ([callout], [button], [highlight], [badge], [divider], etc.)
  working = processShortcodes(working);

  // 3. Process markdown formatting (bold, italic, headers, lists, links)
  working = processMarkdown(working);

  // 4. Sanitize any embedded HTML tags/attributes
  working = sanitizeHtmlString(working);

  // 5. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    working = working.replace(`\x00CODEBLOCK_${i}\x00`, codeBlocks[i]);
  }

  // 6. Split into paragraph blocks
  const blocks = working
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const renderedBlocks = blocks.map((block) => {
    // If the block is already a block-level HTML element (like table, pre, h1-h6, ul, ol, blockquote, div), don't wrap in <p>
    if (BLOCK_HTML_REGEX.test(block)) {
      return linkifyText(block);
    }
    // Normal text/inline paragraph: auto-link bare URLs and convert single newlines to <br>
    const linked = linkifyText(block);
    return `<p style="margin:0 0 18px">${linked.replace(/\n/g, "<br>")}</p>`;
  });

  return renderedBlocks.join("");
}

/**
 * Strips shortcodes, markdown, and HTML tags for a clean plain-text email alternative.
 */
export function formatEmailBodyToText(body: string): string {
  if (!body) return "";

  let out = body;

  // Shortcode text alternatives
  out = out.replace(/\[(callout|box|alert|note)(?:\s+[^\]]*)?\]([\s\S]*?)\[\/\1\]/gi, (_m, _tag, content) => `\n[NOTE: ${content.trim()}]\n`);
  out = out.replace(/\[button(?:\s+([^\]]*))?\]([\s\S]*?)\[\/button\]/gi, (_m, rawAttrs, content) => {
    const attrs = parseShortcodeAttrs(rawAttrs || "");
    const href = attrs.href || attrs.url || "";
    const label = content.trim() || attrs.text || "Click here";
    return href ? `${label} (${href})` : label;
  });
  out = out.replace(/\[button\s+([^\]]*?)\s*\/?\]/gi, (_m, rawAttrs) => {
    const attrs = parseShortcodeAttrs(rawAttrs || "");
    const href = attrs.href || attrs.url || "";
    const label = attrs.text || attrs.label || "Click here";
    return href ? `${label} (${href})` : label;
  });
  out = out.replace(/\[(highlight|mark)(?:\s+[^\]]*)?\]([\s\S]*?)\[\/\1\]/gi, "$2");
  out = out.replace(/\[badge(?:\s+[^\]]*)?\]([\s\S]*?)\[\/badge\]/gi, "[$1]");
  out = out.replace(/\[quote(?:\s+[^\]]*)?\]([\s\S]*?)\[\/quote\]/gi, (_m, content) => `\n> ${content.trim()}\n`);
  out = out.replace(/\[code(?:\s+[^\]]*)?\]([\s\S]*?)\[\/code\]/gi, "`$1`");
  out = out.replace(/\[(divider|hr)\s*\/?\]/gi, "\n------------------------------\n");

  // Markdown links: [text](url) -> text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Strip other markdown marks
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/~~([^~]+)~~/g, "$1");
  out = out.replace(/`([^`]+)`/g, "$1");

  // Convert HTML linebreaks/paragraphs to newlines
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/p>/gi, "\n\n");
  out = out.replace(/<\/div>/gi, "\n");
  out = out.replace(/<\/tr>/gi, "\n");
  out = out.replace(/<\/li>/gi, "\n");

  // Strip remaining HTML tags
  out = out.replace(/<[^>]+>/g, "");

  // Normalize excessive newlines
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
