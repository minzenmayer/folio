import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Folio's editorial palette — directly from the design issues
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
    },
  },
  plugins: [],
};

export default config;
