/** @type {import('tailwindcss').Config} */

/* The canonical DakyXTech palette (docs/DESIGN-SYSTEM.md, version 21, 8 Oct
   2026) — same values as the website's assets/site.css and
   services/letterhead.ts. The admin UI is internal, but it
   is still DakyXTech, so it draws from the one system.
   The gold/bronze/ivory identity this replaced is dead; do not reintroduce it.

   Two layers live here, and the distinction matters:

   PRIMITIVES are the brand's own colours, fixed by DESIGN-SYSTEM.md §2.
   v21 moved them to the logo navy and blue on a cool grey canvas and retired
   lime and cyan. Both names still exist so no class breaks: `cyan` is the
   light blue, and `lime` is the positive status colour — a mark (a bar, a
   live dot), never a button and never a surface for text.

   SEMANTICS say what a colour is *for*. They exist because the design system
   defines a brand and not an operations tool: it has nothing to say about what
   colour a failed send is, so the pages invented one each time. That is how the
   UI ended up with twelve steps of Tailwind's stock amber, ten of its red and
   eight of its emerald — five hundred class names, no rule behind any of them,
   and a palette that belonged to Tailwind rather than to DakyXTech. The status
   families below are the missing half of §03, mixed to sit with ink and blue:
   the reds lean cool, the ambers lean ochre rather than yellow, and `positive`
   is lime walked down towards ink rather than an unrelated emerald, so that
   green and the accent are visibly the same idea at two brightnesses. */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Outfit"', '"Segoe UI"', "sans-serif"],
        sans: ['"Outfit"', '"Segoe UI"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      colors: {
        // --- Primitives: §03, unchangeable ------------------------------
        ink: "#0D1526",
        navy: "#091833",
        blue: "#2563EB",
        "blue-d": "#1D4ED8",
        "blue-light": "#8FB2FF",
        pale: "#EAF1FF",
        cyan: "#8FB2FF",
        lime: "#2F8F5B",
        /* `cream` is the canvas the panels sit on; the name stays because
           174 screens use it. */
        cream: "#ECEEF1",
        canvas: "#ECEEF1",
        muted: "#5B6374",
        line: "#E3E6EB",

        // --- Semantics: surfaces and edges ------------------------------
        /* The one inset surface. Replaces bg-ink/[.02], [.03], [.04], [.05],
           [.06] and bg-ink/5 — six ways of writing the same faint grey, two of
           which were the identical value spelled differently. */
        sunken: "#F6F7F9",
        /* A divider that has to be seen rather than felt: table rules inside a
           card, the edge of a selected row. Replaces border-ink/15, /20, /25. */
        "line-strong": "#D2D7DF",
        /* Text that is deliberately not for reading — placeholders, disabled
           controls, the em dash in an empty cell. Never a label, never a value.
           WCAG exempts these; everything a person actually reads is `ink` or
           `muted`, which is the whole of §05's light-surface text system. */
        faint: "#8A91A0",

        // --- Semantics: status ------------------------------------------
        /* Each family is surface / line / text / solid. `solid` is for marks
           that carry no text — dots, bars, meters. */
        positive: {
          DEFAULT: "#2F8F5B",
          surface: "#EAF6EF",
          line: "#CBE7D6",
          text: "#1D6B41",
        },
        warn: {
          DEFAULT: "#C8871B",
          surface: "#FBF3E4",
          line: "#EDDCBC",
          text: "#7A4E06",
        },
        danger: {
          DEFAULT: "#D33A2C",
          surface: "#FBEEEB",
          line: "#F0CFC7",
          text: "#9A2318",
          /* The one cut for dark surfaces — the bulk bar over the leads table
             and the send-failure line in a thread. `danger.text` is unreadable
             there, which is why those two places had reached for red-300. */
          light: "#F2A9A0",
        },
        info: {
          DEFAULT: "#2563EB",
          surface: "#EAF1FF",
          line: "#CBDAFB",
          text: "#1D4ED8",
        },
      },

      /* §34: one easing for the whole product. Overriding DEFAULT means every
         bare `transition` in the app picks it up, rather than Tailwind's. */
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(.2, .7, .2, 1)",
      },

      /* §24 and §19. Named so a hover state is a decision made once, not an
         arbitrary shadow retyped per component. */
      boxShadow: {
        lift: "0 20px 40px -20px rgba(13,21,38,.4)",
        accent: "0 10px 24px -10px rgba(37,99,235,.5)",
        card: "0 24px 50px -30px rgba(13,21,38,.3)",
        menu: "0 24px 50px -24px rgba(13,21,38,.3)",
        shell: "0 14px 34px -22px rgba(13,21,38,.35)",
      },

      /* Radius is not tokenised on purpose: Tailwind's own xl (12px), 2xl
         (16px) and full already land exactly on §15's small-control, card and
         pill values, so a second set of names for the same numbers would only
         give the codebase two ways to say one thing. §15's floor is 10px, which
         is why `rounded-lg` (8px) does not appear in this UI. */
    },
  },
  plugins: [],
};
