/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      screens: {
        hd: "1440px",
      },
      fontFamily: {
        display: ["Fraunces", "serif"],
        sans: ["Space Grotesk", "sans-serif"],
      },
      colors: {
        ink: "#141415",
        muted: "#6c6d74",
        panel: "#f7f5f1",
        "panel-strong": "#ece7df",
        accent: "#155d6b",
        "accent-soft": "#d7eef1",
        warning: "#d17a22",
        allowed: "#2f7a4f",
        suppressed: "#b23a2f",
        "gh-bg": "#0d1117",
        "gh-surface": "#161b22",
        "gh-surface-2": "#0f141a",
        "gh-border": "#30363d",
        "gh-text": "#c9d1d9",
        "gh-muted": "#8b949e",
        "gh-accent": "#2f81f7",
      },
      boxShadow: {
        panel: "0 18px 32px rgba(20, 20, 21, 0.12)",
        "panel-dark": "0 0 0 1px rgba(48, 54, 61, 0.6), 0 8px 24px rgba(1, 4, 9, 0.6)",
      },
      backgroundImage: {
        app: "radial-gradient(circle at 20% 20%, #f5efe8 0%, #f4f1ec 45%, #efe9e0 100%)",
        "app-dark": "linear-gradient(180deg, #0d1117 0%, #0d1117 100%)",
      },
    },
  },
  plugins: [],
};
