import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Thoughtbed's editorial palette — directly from the design issues.
        // Sprint 12 leaves the hues alone; the aesthetic refresh is shape-only.
        bg: '#f6f1e8',
        paper: '#fbf7ef',
        'paper-2': '#efe8d9',
        'code-bg': '#f0e8d4',
        ink: '#15110c',
        'ink-soft': '#3b342a',
        rule: '#d8cdb6',
        'rule-strong': '#b9ad92',
        accent: '#b8331f',
        'accent-2': '#2d4a3a',
        'accent-soft': '#e0c4ad',
        tag: '#6b5e44',
        olive: '#7a8a3f',
        gold: '#c98a2b',
        plum: '#5b4f88',
      },
      fontFamily: {
        // Bound to next/font CSS variables (defined in layout.tsx)
        serif: ['var(--font-fraunces)', 'Georgia', 'serif'],
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        tightest: '-0.025em',
        tighter: '-0.018em',
        editorial: '-0.012em',
      },
      // Sprint 12 aesthetic refresh: rounder, calmer shapes inspired by
      // Ghostbase. The numeric scale below extends Tailwind's defaults so
      // we can write rounded-card / rounded-soft directly in JSX without
      // memorising pixel values. xl/2xl shortcuts feed inputs/buttons (xl)
      // and cards/panels (2xl); pills stay rounded-full.
      borderRadius: {
        soft: '8px',   // inputs, small buttons
        card: '14px',  // composer card, sidebar nav pill
        panel: '20px', // larger panels, connector cards
      },
      boxShadow: {
        // Subtle hover lift used on cards. Intentionally weaker than
        // Tailwind's default sm so the editorial restraint is preserved.
        soft: '0 1px 2px rgba(21, 17, 12, 0.04), 0 1px 4px rgba(21, 17, 12, 0.03)',
      },
    },
  },
  plugins: [],
};

export default config;
