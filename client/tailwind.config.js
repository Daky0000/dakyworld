/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: ['"Playfair Display"', "Georgia", "serif"],
        sans: ["Inter", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      colors: {
        ink: "#0B0B0C",
        ivory: "#F7F4EE",
        gold: "#C7A24C",
        bronze: "#8A6A2F",
        slate: "#6E6A63",
      },
    },
  },
  plugins: [],
};
