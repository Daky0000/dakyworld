/** @type {import('tailwindcss').Config} */

/* The canonical Dakyworld palette — same values as the website's
   assets/site.css and services/letterhead.ts. The admin UI is internal, but it
   is still Dakyworld, so it draws from the one system.
   The gold/bronze/ivory identity this replaced is dead; do not reintroduce it. */
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
        ink: "#08101F",
        navy: "#0B0A16",
        blue: "#3157FF",
        "blue-light": "#6490FF",
        cyan: "#6FE4FF",
        lime: "#B8FF3D",
        cream: "#F4F5F0",
        muted: "#69758A",
        line: "#DFE4EB",
      },
    },
  },
  plugins: [],
};
