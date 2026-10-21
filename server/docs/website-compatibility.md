# What the Website Builder supports

The contract. Sales promises are made from this file, and the compatibility
report in the product (`Website → Compatibility`) is the same judgement applied
to one particular website — `services/website/compatibility.ts` is where the
rules actually live, and `checks/websiteCompatibility.ts` holds them to it.

The target this is written against, deliberately narrow:

> **A Dakyworld-hosted editor for compatible GitHub-backed websites, onboarded
> and managed by DakyXTech.**

Anything outside that is not a gap to apologise for. It is out of scope until
the flow above works for five to ten genuinely different websites and the people
who own them.

The four grades below are also published, in a client's words, at
[dakyx.com/website-builder](https://dakyx.com/website-builder). Change
one here and change it there in the same piece of work: this file is what sales
promises are made from, and that page is where a client reads them.

## Best supported

- Static HTML and CSS, multi-page.
- Websites DakyXTech built.
- A GitHub repository the OS can read and write, on a named branch.
- Pages whose editable regions are annotated with `data-dw-field`, which is the
  strongest identity an edit can have — it survives the page being rearranged.

On these: text, rich text, links, buttons and their styles, images and their
descriptions, video and audio players and their files, masks (a shape or a
fade), a form's labels, placeholders, button words and drop-down options, the
video, map or player an embedded frame shows (YouTube, Vimeo, Loom, Wistia,
Google Maps, OpenStreetMap, Spotify, SoundCloud, Apple Music and Podcasts,
Google Calendar, Calendly), per-element design at three widths, block
reordering and duplication, shared elements across pages, drafts, review,
publish, versions and rollback. Pages in sub-folders (`blog/post.html`,
`team/index.html`) are listed when the site's sitemap names them, and a split
sitemap (a sitemap index) is followed.

## Editable, with limits

- **Imported HTML files** — the same editing, with no repository behind them
  until one is connected, so publishing is not available.
- **JavaScript-enhanced static sites.** Scripts do not run in the preview, so
  menus, sliders, tabs and anything else script-driven will not behave in the
  editor the way they do live. What is edited still publishes correctly. Test the
  live page afterwards.
- **Pictures with more than one size.** Replacing an image drops its `srcset`
  candidates, so the new picture is used at every size.
- **Sites built by an AI** (Lovable, Bolt, v0, Replit) — their pages are read
  out of the route table in `App.tsx`, and their words out of component props
  (`<Hero title="…" />`), data arrays and content files. A prop or key is
  offered only when its name reads as content: `className`, `variant`, `icon`
  and `id` stay with the code, because editing one changes the design rather
  than the words.
- **Markdown pages** — front matter values whose key is content (`title`,
  `description`, `author`), and the body as one field. Tags, dates, layouts and
  block values stay with the code.
- **Framework source files** — literal text and existing `href`/`src`/`alt`
  strings in `.jsx`, `.tsx`, `.astro`, `.vue`, `.svelte` and Angular `.html`
  template files, through the source editor. Next.js, Remix and React Router,
  Gatsby, Astro, SvelteKit, Nuxt, Vue (file-routed, or a Vue Router table),
  Svelte with Vite, Angular (its `Routes` table), SolidStart, TanStack Start,
  Qwik City and Vite React projects list their route files as pages and open
  them here; so do the Markdown generators — Docusaurus, VitePress, MkDocs,
  Eleventy, Hugo, Jekyll and Hexo (Hexo's pages; its posts open from the file
  browser, because a post's address comes from its date). Not a visual
  canvas, and nothing is built or run: what is committed is the file with the
  edited strings in it, for your own host to build as usual.
- **VitePress rooted outside `docs/` or the repository root** — pictures
  uploaded for a page go to `docs/public/` or `public/`; a project whose
  `.vitepress/` sits in another folder needs them moved by hand.
- **Expressions inside those files stay with the code.** A Svelte `{#if}`, a Vue
  `{{ mustache }}`, an Astro expression, a bound attribute (`:href`, `bind:`,
  `@click`, `client:load`), Astro frontmatter and `<script setup>` are reported
  as notes rather than edited. A brace typed into a text box is escaped, so it
  stays a word instead of becoming a template hole.
- **Links whose destination is decided by script.** Their words are editable;
  where they go is not.

## Developer-managed

Real parts of a website that stay with whoever writes the code. The editor reads
them, reports them, and never changes them:

- application logic, and anything rendered by it;
- custom components and custom elements;
- what a form does when it is submitted (its labels, placeholders, button
  words and options are editable);
- embedded frames from services not on the list above — booking widgets,
  forms, chat, anything else drawn from another site. These can be moved,
  styled and deleted; pointing one at a different address is the developer's,
  because a frame shows another site *inside* this one;
- behaviour written into markup attributes (`onclick` and friends);
- `<picture>` source groups and other advanced responsive image systems;
- templates filled in at run time.

## Not supported

- General React/Next visual editing — a running application canvas. Framework
  files edit as source, with a review before each commit, and never as a live
  preview of the running app.
- WordPress, Shopify or any other CMS's own editing model.
- Publishing anywhere but GitHub: no SFTP, no FTP. **One narrow exception**
  (Dan, 20 Oct 2026): DakyX may deploy to a customer's host through that host's
  official deploy API, only when the customer has connected their host account
  through the host's own sign-in (OAuth) or a scoped token, and only for sites
  with no build step. The commit to GitHub still happens first and stays the
  record. See `docs/publish-router.md`, Route A.
- Arbitrary component creation, template marketplaces, AI site generation.
- Self-hosted or white-label installations of the builder itself.

A page with no fixed content at all — a JavaScript application shell — is
refused at import with an explanation rather than accepted and left blank.

## The grades the product uses

| Grade | Means | Example |
|---|---|---|
| **Fully editable** | Change it here, safely | A heading, a paragraph, a button, a photograph |
| **Editable, with limits** | Editable once you know one thing | An image with an `srcset`; a page with a script-driven menu |
| **Developer-managed** | Real, and it stays with the code | A form's behaviour, an embedded map, a custom component |
| **Not supported** | This editor cannot carry it | An application shell with no fixed content |

A site's rating is the worst grade any of its pages earns, and its readiness is a
separate question — a perfectly editable site with no repository connected is
`PUBLISH_BLOCKED`, not "limited", because nothing about its pages is the problem.

| Readiness | Means |
|---|---|
| `CONNECTED` | Connected, nothing scanned yet |
| `READY` | Everything editable here, and publishable |
| `LIMITED` | Editable and publishable, with developer-managed parts |
| `NEEDS_REVIEW` | Some pages cannot be carried; decide before a client is given access |
| `PUBLISH_BLOCKED` | Editable, but nothing can go live until the repository or token is fixed |

## Before a client is given access

1. Scan the site and open `Website → Compatibility`.
2. Read the findings out loud in the onboarding conversation. Every one of them
   is a sentence a client can act on; none of them is a bug.
3. Agree who owns the developer-managed parts.
4. Confirm publishing works — the report says whether it can.
5. Assign the client's access under `Website → Team & Permissions`.
