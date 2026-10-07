import { useState } from "react";
import { parseStyle, writeStyle } from "./InspectorControls";
import { Acc, Field, Seg, Slider, TILE_ICON, Tiles, type TileOption } from "./InspectorDesign";

/**
 * The Interactions tab: how an element arrives, what happens when it is
 * clicked, whether it keeps moving, and what scrolling does to it.
 *
 * Nothing here writes CSS. Each choice is a keyframe name or a number in a
 * `--dw-*` custom property on the element's own style, and the fixed rules in
 * `shared/websiteInteraction.ts` (`MOTION_CSS`) turn those into animation on
 * the published page — so a stored value can only pick one of the animations
 * that exist. A click "action" is the link's real destination: `wa.me`,
 * `tel:` and `mailto:` addresses, not script.
 */

const ENTRANCE: TileOption[] = [
  { value: "", label: "None", icon: TILE_ICON.none },
  { value: "dw-enter-fade", label: "Fade in", icon: TILE_ICON.eye },
  { value: "dw-enter-up", label: "Slide up", icon: TILE_ICON.up },
  { value: "dw-enter-down", label: "Slide down", icon: TILE_ICON.down },
  { value: "dw-enter-left", label: "Slide left", icon: TILE_ICON.left },
  { value: "dw-enter-right", label: "Slide right", icon: TILE_ICON.right },
  { value: "dw-enter-zoom", label: "Zoom in", icon: TILE_ICON.plus },
  { value: "dw-enter-blur", label: "Blur in", icon: TILE_ICON.drop },
  { value: "dw-enter-flip", label: "Flip", icon: TILE_ICON.swap },
];
const LOOP: TileOption[] = [
  { value: "", label: "None", icon: TILE_ICON.none },
  { value: "dw-loop-pulse", label: "Pulse", icon: TILE_ICON.spark },
  { value: "dw-loop-float", label: "Float", icon: TILE_ICON.up },
  { value: "dw-loop-bounce", label: "Bounce", icon: TILE_ICON.down },
  { value: "dw-loop-shake", label: "Shake", icon: TILE_ICON.swap },
  { value: "dw-loop-wiggle", label: "Wiggle", icon: TILE_ICON.reload },
  { value: "dw-loop-spin", label: "Spin", icon: TILE_ICON.reload },
];
const CLICK: TileOption[] = [
  { value: "", label: "None", icon: TILE_ICON.none },
  { value: "press", label: "Press", icon: TILE_ICON.cursor },
  { value: "pop", label: "Pop", icon: TILE_ICON.plus },
  { value: "flash", label: "Flash", icon: TILE_ICON.bolt },
];
const SCROLL: TileOption[] = [
  { value: "", label: "None", icon: TILE_ICON.none },
  { value: "dw-scroll-parallax", label: "Parallax", icon: TILE_ICON.layers },
  { value: "dw-scroll-fade", label: "Fade on scroll", icon: TILE_ICON.eye },
  { value: "sticky", label: "Sticky", icon: TILE_ICON.pin },
];
const EASE: Record<string, string> = {
  Smooth: "cubic-bezier(.22,1,.36,1)",
  Gentle: "ease-in-out",
  Bouncy: "cubic-bezier(.34,1.56,.64,1)",
  Snappy: "cubic-bezier(.2,0,0,1)",
  Linear: "linear",
};
const SPEED = { Slow: "2.4s", Normal: "1.4s", Fast: "0.8s" } as const;

type Action = "keep" | "page" | "link" | "whatsapp" | "phone" | "email";

function actionOf(href: string): Action {
  if (/^https:\/\/wa\.me\//i.test(href)) return "whatsapp";
  if (/^tel:/i.test(href)) return "phone";
  if (/^mailto:/i.test(href)) return "email";
  if (/^https?:\/\//i.test(href)) return "link";
  if (href.startsWith("/") || href.startsWith("#")) return "page";
  return "keep";
}

const seconds = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function WebsiteMotionPanel({
  element,
  style,
  kind,
  href,
  pages,
  readOnly,
  onChange,
  onHref,
}: {
  element: HTMLElement | null;
  style: string;
  kind: string;
  href: string;
  pages: { label: string; href: string }[];
  readOnly: boolean;
  onChange: (style: string) => void;
  onHref: (href: string) => void;
}) {
  const map = parseStyle(style);
  const write = (patch: Record<string, string | null>) => {
    const next = { ...map };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") delete next[key];
      else next[key] = value;
    }
    onChange(writeStyle(next));
  };

  /** Plays the entrance again in the editing frame, ignoring the scroll timeline. */
  const replay = (property: "animation") => {
    if (!element) return;
    element.style.setProperty("animation-timeline", "auto");
    element.style.setProperty(property, "none");
    void element.offsetWidth;
    element.style.removeProperty(property);
    window.setTimeout(() => element.style.removeProperty("animation-timeline"), seconds(map["--dw-enter-dur"], 0.6) * 1000 + seconds(map["--dw-enter-delay"], 0) * 1000 + 100);
  };

  const enter = map["--dw-enter"] ?? "";
  const loop = map["--dw-loop"] ?? "";
  const scroll = map.position === "sticky" && map["--dw-scroll"] === undefined ? "sticky" : map["--dw-scroll"] ?? "";
  const click = map["--dw-active-transform"] === "scale(.94)" ? "press" : map["--dw-active-transform"] === "scale(1.08)" ? "pop" : map["--dw-active-opacity"] ? "flash" : "";
  const ease = Object.entries(EASE).find(([, curve]) => curve === map["--dw-enter-ease"])?.[0] ?? "Smooth";
  const speed = (Object.entries(SPEED).find(([, duration]) => duration === map["--dw-loop-dur"])?.[0] ?? "Normal") as keyof typeof SPEED;
  const clickable = kind === "link" || kind === "button";
  const [action, setAction] = useState<Action>(() => actionOf(href));
  const label = (options: TileOption[], value: string) => options.find((option) => option.value === value)?.label ?? "None";

  return (
    <fieldset disabled={readOnly} className="dx-motion">
      <Acc title="Entrance animation" summary={label(ENTRANCE, enter)} open>
        <p className="dx-hint">How it appears on the page.</p>
        <Tiles
          label="Entrance animation"
          options={ENTRANCE}
          value={enter}
          onChange={(value) => {
            write({ "--dw-enter": value, ...(value ? {} : { "--dw-enter-dur": null, "--dw-enter-delay": null, "--dw-enter-ease": null, "--dw-enter-start": null }) });
            if (value) window.setTimeout(() => replay("animation"), 60);
          }}
        />
        {enter && (
          <>
            <Field label="Starts">
              <select
                aria-label="Starts"
                value={map["--dw-enter-start"] ? "load" : "scroll"}
                onChange={(event) => write({ "--dw-enter-start": event.target.value === "load" ? "load" : null })}
              >
                <option value="scroll">When scrolled into view</option>
                <option value="load">When the page loads</option>
              </select>
            </Field>
            <Slider label="Duration" min={0.2} max={2} step={0.1} unit="s" value={seconds(map["--dw-enter-dur"], 0.6)} onChange={(value) => write({ "--dw-enter-dur": `${value}s` })} />
            <Slider label="Delay" min={0} max={2} step={0.1} unit="s" value={seconds(map["--dw-enter-delay"], 0)} onChange={(value) => write({ "--dw-enter-delay": value ? `${value}s` : null })} />
            <Field label="Feel">
              <select aria-label="Feel" value={ease} onChange={(event) => write({ "--dw-enter-ease": event.target.value === "Smooth" ? null : EASE[event.target.value] })}>
                {Object.keys(EASE).map((name) => <option key={name}>{name}</option>)}
              </select>
            </Field>
            <button type="button" className="dx-btn dx-soft dx-full" onClick={() => replay("animation")}>
              {TILE_ICON.play}Preview
            </button>
          </>
        )}
      </Acc>

      <Acc title="When clicked" summary={clickable ? { keep: "As set", page: "Open a page", link: "Open a link", whatsapp: "WhatsApp", phone: "Call", email: "Email" }[action] : label(CLICK, click)} open>
        {clickable ? (
          <>
            <Field label="Action">
              <select aria-label="Click action" value={action} onChange={(event) => setAction(event.target.value as Action)}>
                {action === "keep" && <option value="keep">Keep what it does now</option>}
                <option value="page">Open a page</option>
                <option value="link">Open a link</option>
                <option value="whatsapp">Chat on WhatsApp</option>
                <option value="phone">Call a phone number</option>
                <option value="email">Send an email</option>
              </select>
            </Field>
            {action === "page" && (
              <Field label="Page">
                <select aria-label="Page" value={href} onChange={(event) => onHref(event.target.value)}>
                  {!pages.some((page) => page.href === href) && <option value={href}>{href || "Choose a page"}</option>}
                  {pages.map((page) => <option key={page.href} value={page.href}>{page.label}</option>)}
                </select>
              </Field>
            )}
            {action === "link" && (
              <Field label="Web address">
                <input type="text" aria-label="Web address" defaultValue={actionOf(href) === "link" ? href : ""} placeholder="https://" onBlur={(event) => /^https?:\/\/\S+$/i.test(event.target.value.trim()) && onHref(event.target.value.trim())} />
              </Field>
            )}
            {action === "whatsapp" && (
              <Field label="WhatsApp number">
                <input
                  type="text"
                  aria-label="WhatsApp number"
                  defaultValue={actionOf(href) === "whatsapp" ? href.replace(/^https:\/\/wa\.me\//i, "+").replace(/\?.*$/, "") : ""}
                  placeholder="+233 20 000 0000"
                  onBlur={(event) => {
                    const digits = event.target.value.replace(/\D/g, "");
                    if (digits.length >= 8) onHref(`https://wa.me/${digits}`);
                  }}
                />
              </Field>
            )}
            {action === "phone" && (
              <Field label="Phone">
                <input type="text" aria-label="Phone" defaultValue={href.replace(/^tel:/i, "")} placeholder="+233 20 000 0000" onBlur={(event) => { const tel = event.target.value.replace(/[^\d+]/g, ""); if (tel.length >= 8) onHref(`tel:${tel}`); }} />
              </Field>
            )}
            {action === "email" && (
              <Field label="Email address">
                <input type="text" aria-label="Email address" defaultValue={href.replace(/^mailto:/i, "")} placeholder="hello@business.com" onBlur={(event) => { const email = event.target.value.trim(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) onHref(`mailto:${email}`); }} />
              </Field>
            )}
          </>
        ) : (
          <p className="dx-hint">Only links and buttons go somewhere when clicked. Anything can have a click effect.</p>
        )}
        <Field label="Click effect">
          <Tiles
            label="Click effect"
            options={CLICK}
            value={click}
            onChange={(value) =>
              write({
                "--dw-active-transform": value === "press" ? "scale(.94)" : value === "pop" ? "scale(1.08)" : null,
                "--dw-active-opacity": value === "flash" ? "0.5" : null,
                transition: value && !map.transition ? "transform 150ms, opacity 150ms" : map.transition ?? null,
              })
            }
          />
        </Field>
      </Acc>

      <Acc title="Looping animation" summary={label(LOOP, loop)}>
        <p className="dx-hint">Keeps moving to draw attention. Use sparingly.</p>
        <Tiles label="Looping animation" options={LOOP} value={loop} onChange={(value) => write({ "--dw-loop": value, ...(value ? {} : { "--dw-loop-dur": null }) })} />
        {loop && (
          <Field label="Speed">
            <Seg label="Loop speed" value={speed} options={(Object.keys(SPEED) as (keyof typeof SPEED)[]).map((name) => ({ value: name, label: name }))} onChange={(name) => write({ "--dw-loop-dur": name === "Normal" ? null : SPEED[name] })} />
          </Field>
        )}
      </Acc>

      <Acc title="Scroll effect" summary={label(SCROLL, scroll)}>
        <Tiles
          label="Scroll effect"
          options={SCROLL}
          value={scroll}
          onChange={(value) =>
            write({
              "--dw-scroll": value === "sticky" ? null : value,
              "--dw-scroll-strength": value === "dw-scroll-parallax" ? map["--dw-scroll-strength"] ?? "40" : null,
              position: value === "sticky" ? "sticky" : map.position === "sticky" ? null : map.position ?? null,
              top: value === "sticky" ? map.top ?? "0px" : map.position === "sticky" ? null : map.top ?? null,
            })
          }
        />
        {scroll === "dw-scroll-parallax" && (
          <Slider label="Strength" min={0} max={100} unit="%" value={Number(map["--dw-scroll-strength"] ?? 40)} onChange={(value) => write({ "--dw-scroll-strength": String(value) })} />
        )}
        {scroll && scroll !== "sticky" && <p className="dx-hint">Plays as visitors scroll, in browsers that support it. Others show the element as it is.</p>}
      </Acc>
    </fieldset>
  );
}
