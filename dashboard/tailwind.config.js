/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  // Gate `dark:` variants off the same [data-theme="dark"] attribute the
  // theme toggle (useTheme.js) sets on <html> -- lets pages built with raw
  // Tailwind neutrals (stone/white) opt into dark mode via `dark:` classes
  // without rewriting them to the CSS-variable pattern used elsewhere.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        // "amber" token recolored to a champagne-gold accent for the luxury palette.
        amber: {
          50:  '#faf3e1',
          100: '#f3e4bd',
          200: '#e9cc85',
          300: '#deb454',
          400: '#d4af37',
          500: '#bb9230',
          600: '#9c7726',
          700: '#7d5f1f',
          800: '#5e4717',
          900: '#3f2f0f',
        },
        // "stone" token recolored to a warm espresso-brown neutral scale.
        stone: {
          50:  '#fbf8f4',
          100: '#f2ebe1',
          200: '#e3d4c0',
          300: '#cbb293',
          400: '#a8835d',
          500: '#7e5d3d',
          600: '#5e4530',
          700: '#473426',
          800: '#2e2118',
          900: '#1a130d',
        },
      },
    },
  },
  plugins: [],
}
