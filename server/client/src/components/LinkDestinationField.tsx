import { useEffect, useId, useState } from "react";

/**
 * Where clicking an element goes, under Settings → Link.
 *
 * Links and buttons already have a destination; words, pictures and containers
 * get one by being wrapped in a link, which the server writes around the element when
 * a destination is set and takes away again when it is cleared.
 */
export function LinkDestinationField({
  href,
  kind,
  pages,
  readOnly,
  onHref,
}: {
  href: string;
  kind: string;
  pages: { label: string; href: string }[];
  readOnly?: boolean;
  onHref: (href: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(href);
  useEffect(() => setText(href), [href]);
  const wraps = kind === "text" || kind === "richtext" || kind === "container" || kind === "image";
  const commit = (next: string) => {
    const value = next.trim();
    if (value !== href) onHref(value);
  };
  return (
    <div className="dx-f" style={{ marginBottom: 12 }}>
      <div className="dx-fl">
        <label htmlFor={id}>
          Link {wraps && <span className="dx-opt">(optional)</span>}
        </label>
      </div>
      <div className="dx-inp">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
        </svg>
        <input
          id={id}
          type="text"
          list={`${id}-pages`}
          disabled={readOnly}
          value={text}
          placeholder={kind === "container" ? "Make the whole block a link: /page or https://…" : kind === "image" ? "Where clicking the picture goes" : "/page, https://…, mailto: or tel:"}
          onChange={(event) => setText(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(event.currentTarget.value);
            }
          }}
        />
        <datalist id={`${id}-pages`}>
          {pages.map((page) => <option key={page.href} value={page.href}>{page.label}</option>)}
        </datalist>
      </div>
      {wraps && href && !readOnly && (
        <button type="button" className="dx-btn dx-ghost dx-full" style={{ marginTop: 6 }} onClick={() => { setText(""); onHref(""); }}>
          Remove link
        </button>
      )}
    </div>
  );
}
