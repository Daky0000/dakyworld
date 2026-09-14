# Making an AI-built site editable

Written for: a customer whose site was built by Lovable, Bolt, v0, Replit or
Cursor, and whoever helps them connect it.

The Website Builder opens your pages, shows the built page, and lets you change
its words, links and pictures — then commits the change to your repository and
lets your host rebuild. It works on an ordinary project with nothing added.

It works **better**, and stays right when your site is redesigned, if the code
names the editable pieces. That is one instruction to your AI builder.

## The instruction

Paste this into Lovable, Bolt, v0, Replit or Cursor:

> Put a `data-dw-field` marker on every element that holds words, a link, or an
> image a non-developer would want to change. Use a dotted name for what it is,
> not where it sits — `hero.title`, `hero.cta`, `pricing.starter.price`,
> `services.1.title`. Each marker must be unique on the page. Keep the text
> itself as a plain string in the JSX, not a computed expression.

For a component that takes its copy as props, the same idea:

```tsx
<Hero
  data-dw-field="hero"
  title="Websites that win customers"
  subtitle="We build, connect and improve the systems behind them."
  ctaText="Talk to us"
  ctaHref="/contact"
/>
```

## Why it matters

Without markers, the editor matches a heading on your built page to the string
in your source by **its exact words**, and only when those words appear once on
the page. That is enough day to day. It has two limits:

- two identical paragraphs match nothing, so neither is editable;
- rewording a heading in the code and rebuilding is fine, but moving text
  between components can lose the link until the page is opened again.

With markers, the match is by name. The words can change, the element can move,
the component can be rewritten around it, and the editor still knows which
string is which.

## What stays with the developer either way

- **Styling.** Classes, stylesheets, design tokens — the editor cannot write
  them into your source, because the rendered element did not come from a
  literal in the file.
- **Layout and structure.** Adding, moving or deleting a section changes the
  code that builds the page.
- **Anything computed.** Text from an API or a CMS, a value built from a
  variable, a `.map()` over data.

These are shown on the page and marked read-only, with a note saying where they
come from. Nothing about them is hidden; they simply belong to the code.
