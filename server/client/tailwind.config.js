/** @type {import('tailwindcss').Config} */

/* The canonical Dakyworld palette — same values as the website's
   assets/site.css and services/letterhead.ts. The admin UI is internal, but it
   is still Dakyworld, so it draws from the one system.
   The gold/bronze/ivory identity this replaced is dead; do not reintroduce it.

   Two layers live here, and the distinction matters:

   PRIMITIVES are the brand's own colours, fixed by
   DAKYWORLD-BRAND-DESIGN-SYSTEM.md §03. They never change.

   SEMANTICS say what a colour is *for*. They exist because the design system
   defines a brand and not an operations tool: it has nothing to say about what
   colour a failed send is, so the pages invented one each time. That is how the
   UI ended up with twelve steps of Tailwind's stock amber, ten of its red and
   eight of its emerald — five hundred class names, no rule behind any of them,
   and a palette that belonged to Tailwind rather than to Dakyworld. The status
   families below are the missing half of §03, mixed to sit with ink and blue:
   the reds lean cool, the ambers lean ochre rather than yellow, and `positive`
   is lime walked down towards ink rather than an unrelated emerald, so that
   green and the accent are visibly the same idea at two brightnesses. */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Space Grotesk"', '"DM Sans"', "sans-serif"],
        sans: ['"DM Sans"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      colors: {
        // --- Primitives: §03, unchangeable ------------------------------
        ink: "#08101F",
        navy: "#0B0A16",
        blue: "#3157FF",
        "blue-light": "#6490FF",
        cyan: "#6FE4FF",
        lime: "#B8FF3D",
        cream: "#F4F5F0",
        muted: "#69758A",
        line: "#DFE4EB",

        // --- Semantics: surfaces and edges ------------------------------
        /* The one inset surface. Replaces bg-ink/[.02], [.03], [.04], [.05],
           [.06] and bg-ink/5 — six ways of writing the same faint grey, two of
           which were the identical value spelled differently. */
        sunken: "#F5F6F8",
        /* A divider that has to be seen rather than felt: table rules inside a
           card, the edge of a selected row. Replaces border-ink/15, /20, /25. */
        "line-strong": "#C6CDD8",
        /* Text that is deliberately not for reading — placeholders, disabled
           controls, the em dash in an empty cell. Never a label, never a value.
           WCAG exempts these; everything a person actually reads is `ink` or
           `muted`, which is the whole of §05's light-surface text system. */
        faint: "#98A1B0",

        // --- Semantics: status ------------------------------------------
        /* Each family is surface / line / text / solid. `solid` is for marks
           that carry no text — dots, bars, meters. */
        positive: {
          DEFAULT: "#5C8C14",
          surface: "#F1F7E2",
          line: "#DCE9BF",
          text: "#3A5A0C",
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
          DEFAULT: "#3157FF",
          surface: "#EDF1FF",
          line: "#CFD9FF",
          text: "#1E3AAE",
        },
      },

      /* §34: one easing for the whole product. Overriding DEFAULT means every
         bare `transition` in the app picks it up, rather than Tailwind's. */
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(.16, 1, .3, 1)",
      },

      /* §24 and §19. Named so a hover state is a decision made once, not an
         arbitrary shadow retyped per component. */
      boxShadow: {
        lift: "0 10px 24px rgba(8,16,31,.18)",
        accent: "0 10px 28px rgba(184,255,61,.32)",
        card: "0 25px 65px rgba(8,16,31,.08)",
        menu: "0 18px 40px rgba(8,16,31,.14)",
        shell: "0 10px 30px rgba(8,16,31,.22)",
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
