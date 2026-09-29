/**
 * Compiles and hydrates Claude Dynamic Components (<x-dc>, <sc-for>, <sc-if>,
 * <script type="text/x-dc">, class Component extends DCLogic, and mustache bindings {{ ... }})
 * into clean, static, browser-standard HTML.
 *
 * Runs identically in Node.js and in the browser.
 */
export function compileClaudeDynamicTemplate(html: string): string {
  if (!html || typeof html !== "string") return html;

  // Fast check: if not a dynamic component / template, return untouched
  const hasXdc = html.includes("<x-dc") || html.includes("</x-dc>");
  const hasScTags = html.includes("<sc-if") || html.includes("<sc-for");
  const hasDcScript = html.includes("text/x-dc") || html.includes("data-dc-script") || html.includes("DCLogic");
  const hasMustache = /\{\{\s*[\w.?!'"]+\s*\}\}/.test(html);

  if (!hasXdc && !hasScTags && !hasDcScript && !hasMustache) {
    return html;
  }

  // 1. Locate Component script (type="text/x-dc" or data-dc-script containing class Component)
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let componentCode: string | null = null;
  const componentProps: Record<string, any> = {};
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const attrs = match[1];
    const content = match[2];
    if (
      attrs.includes("text/x-dc") ||
      (attrs.includes("data-dc-script") && content.includes("class Component extends DCLogic"))
    ) {
      componentCode = content;
      const propsMatch = /data-props=["']([\s\S]*?)["']/.exec(attrs);
      if (propsMatch) {
        try {
          const decoded = propsMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
          const meta = JSON.parse(decoded);
          for (const [k, v] of Object.entries(meta as Record<string, any>)) {
            if (v && v.default !== undefined) componentProps[k] = v.default;
          }
        } catch {}
      }
      break;
    }
  }

  // 2. Build initial scope from Component class or defaults
  let initialScope: Record<string, any> = { ...componentProps, wide: true, showEvents: true };

  if (componentCode) {
    try {
      class DCLogic {
        props: Record<string, any>;
        state: Record<string, any>;
        constructor() {
          this.props = { ...componentProps };
          this.state = { w: 1280, q: "", rec: null, slide: 0 };
        }
        setState(fn: any) {
          if (typeof fn === "function") this.state = Object.assign({}, this.state, fn(this.state));
          else if (fn) Object.assign(this.state, fn);
        }
        renderVals() {
          return {};
        }
      }
      const win = { __resources: {}, innerWidth: 1280, addEventListener: () => {}, removeEventListener: () => {} };
      const fn = new Function(
        "DCLogic",
        "StreamableLogic",
        "React",
        "window",
        componentCode + '\n; return typeof Component !== "undefined" ? Component : null;'
      );
      const CompCls = fn(DCLogic, DCLogic, {}, win);
      if (CompCls) {
        const instance = new CompCls();
        const vals = typeof instance.renderVals === "function" ? instance.renderVals() : {};
        initialScope = { ...initialScope, ...instance.state, ...vals };
      }
    } catch (e) {
      console.warn("[htmlCompiler] Failed to evaluate Component class:", e);
    }
  }

  // 3. Expression evaluator with fallback
  function evalInScope(expr: string, scope: Record<string, any>): any {
    const cleanExpr = expr.trim().replace(/^\{\{|\}\}$/g, "").trim();
    if (!cleanExpr) return "";
    try {
      const keys = Object.keys(scope);
      const fn = new Function(...keys, `try { return (${cleanExpr}); } catch { return undefined; }`);
      const res = fn(...keys.map((k) => scope[k]));
      if (res !== undefined) return res;
    } catch {}

    // Dot navigation fallback
    const parts = cleanExpr.split(".");
    let cur: any = scope;
    for (const p of parts) {
      if (cur == null) return "";
      cur = cur[p];
    }
    return cur ?? "";
  }

  // 4. Recursive template renderer for <sc-if>, <sc-for>, {{ expr }}
  function renderTemplate(tpl: string, scope: Record<string, any>): string {
    let pos = 0;
    let out = "";

    while (pos < tpl.length) {
      const ifIdx = tpl.indexOf("<sc-if", pos);
      const forIdx = tpl.indexOf("<sc-for", pos);

      let nextTag: "sc-if" | "sc-for" | null = null;
      let nextIdx = -1;

      if (ifIdx !== -1 && forIdx !== -1) {
        if (ifIdx < forIdx) {
          nextTag = "sc-if";
          nextIdx = ifIdx;
        } else {
          nextTag = "sc-for";
          nextIdx = forIdx;
        }
      } else if (ifIdx !== -1) {
        nextTag = "sc-if";
        nextIdx = ifIdx;
      } else if (forIdx !== -1) {
        nextTag = "sc-for";
        nextIdx = forIdx;
      }

      if (nextIdx === -1) {
        out += interpolateMustache(tpl.slice(pos), scope);
        break;
      }

      out += interpolateMustache(tpl.slice(pos, nextIdx), scope);

      const openTagEnd = tpl.indexOf(">", nextIdx);
      if (openTagEnd === -1) {
        out += tpl.slice(nextIdx);
        break;
      }

      const openTagHeader = tpl.slice(nextIdx, openTagEnd + 1);
      const closeTagName = `</${nextTag}>`;
      const openTagName = `<${nextTag}`;

      let depth = 1;
      let searchPos = openTagEnd + 1;
      let closeTagStart = -1;

      while (searchPos < tpl.length) {
        const nextOpen = tpl.indexOf(openTagName, searchPos);
        const nextClose = tpl.indexOf(closeTagName, searchPos);

        if (nextClose === -1) break;

        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          searchPos = nextOpen + openTagName.length;
        } else {
          depth--;
          if (depth === 0) {
            closeTagStart = nextClose;
            break;
          }
          searchPos = nextClose + closeTagName.length;
        }
      }

      if (closeTagStart === -1) {
        pos = openTagEnd + 1;
        continue;
      }

      const innerContent = tpl.slice(openTagEnd + 1, closeTagStart);
      const closeTagEnd = closeTagStart + closeTagName.length;
      pos = closeTagEnd;

      if (nextTag === "sc-if") {
        const valMatch = /value=["']([^"']*)["']/.exec(openTagHeader);
        const hintMatch = /hint-placeholder-val=["']([^"']*)["']/.exec(openTagHeader);
        const condExpr = valMatch ? valMatch[1] : "";
        let isTrue = Boolean(evalInScope(condExpr, scope));
        if (!condExpr && hintMatch) {
          isTrue = hintMatch[1].trim() === "true" || hintMatch[1].trim() === "{{ true }}";
        }
        if (isTrue) {
          out += renderTemplate(innerContent, scope);
        }
      } else if (nextTag === "sc-for") {
        const listMatch = /list=["']([^"']*)["']/.exec(openTagHeader);
        const asMatch = /as=["']([^"']*)["']/.exec(openTagHeader);
        const listExpr = listMatch ? listMatch[1] : "";
        const asVar = asMatch ? asMatch[1].trim() : "item";

        const listVal = evalInScope(listExpr, scope);
        if (Array.isArray(listVal)) {
          for (let i = 0; i < listVal.length; i++) {
            const item = listVal[i];
            const childScope = { ...scope, [asVar]: item, [`${asVar}Index`]: i };
            out += renderTemplate(innerContent, childScope);
          }
        }
      }
    }

    return out;
  }

  function interpolateMustache(text: string, scope: Record<string, any>): string {
    return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expr) => {
      const val = evalInScope(expr, scope);
      if (typeof val === "function") return "";
      if (val === null || val === undefined) return "";
      return String(val);
    });
  }

  let result = html;

  // Unpack and render <x-dc> container (find the last </x-dc> in body)
  const lastClose = result.lastIndexOf("</x-dc>");
  if (lastClose !== -1) {
    const openIdx = result.lastIndexOf("<x-dc", lastClose);
    if (openIdx !== -1) {
      const openTagEnd = result.indexOf(">", openIdx);
      if (openTagEnd !== -1 && openTagEnd < lastClose) {
        let xdcInner = result.slice(openTagEnd + 1, lastClose);

        // Extract <helmet> from xdcInner
        const helmetMatch = /<(?:sc-)?helmet\b[^>]*>([\s\S]*?)<\/(?:sc-)?helmet>/i.exec(xdcInner);
        let helmetContent = "";
        if (helmetMatch) {
          helmetContent = helmetMatch[1];
          xdcInner = xdcInner.slice(0, helmetMatch.index) + xdcInner.slice(helmetMatch.index + helmetMatch[0].length);
        }

        const renderedXdc = renderTemplate(xdcInner, initialScope);
        result = result.slice(0, openIdx) + renderedXdc + result.slice(lastClose + "</x-dc>".length);

        if (helmetContent.trim()) {
          if (result.includes("</head>")) {
            result = result.replace("</head>", `${helmetContent}\n</head>`);
          } else {
            result = `${helmetContent}\n${result}`;
          }
        }
      }
    }
  } else {
    result = renderTemplate(result, initialScope);
  }

  // Remove inert <script type="text/x-dc"> tags
  result = result.replace(/<script\b[^>]*\btype=["']text\/x-dc["'][^>]*>[\s\S]*?<\/script>/gi, "");
  // Remove DC runtime script if present (it loads React UMD from unpkg and is no longer needed)
  result = result.replace(
    /<script\b[^>]*>[\s\S]*?(?:GENERATED from dc-runtime|createRuntime|loadReactUmd)[\s\S]*?<\/script>/gi,
    ""
  );

  // Clean up any remaining sc-camel-* event handlers or hint-placeholder attributes
  result = result.replace(/\s+sc-camel-[a-z0-9_-]+=(?:"[^"]*"|'[^']*')/gi, "");
  result = result.replace(/\s+hint-placeholder-[a-z0-9_-]+=(?:"[^"]*"|'[^']*')/gi, "");

  return result;
}
