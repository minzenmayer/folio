import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Sprint 14 — Ghostbase brand pivot.
        // The product was editorial cream + red; the founder pivoted hard to
        // Ghostbase's monochrome black/white. Tokens stay name-stable so
        // existing classes (bg-paper, text-ink, border-rule, etc.) keep
        // working — we just remap the values to grayscale.
        bg: '#fafafa',           // page background — near-white grey (zinc-50)
        paper: '#ffffff',        // cards / inputs — pure white
        'paper-2': '#f4f4f5',    // hover surfaces / chip fills (zinc-100)
        // Phase 16 (2026-05-05) — composer v2 zone differentiation. The spar
        // surface needed a third paper level so the follow-up question card
        // reads as distinct from angles / outline cards. Stays in the zinc
        // family (no warm-cream pivot — the brand is monochrome).
        'paper-3': '#e4e4e7',    // emphasized fills (zinc-200)
        'code-bg': '#f4f4f5',    // inline code / pre blocks (zinc-100)
        ink: '#0a0a0a',          // primary text — near-black (zinc-950)
        'ink-soft': '#52525b',   // secondary text (zinc-600)
        rule: '#e4e4e7',         // borders (zinc-200)
        'rule-strong': '#d4d4d8', // emphasised borders (zinc-300)
        // Accent now means "primary action" (black). Held name-stable so
        // existing 'accent' classes still resolve, just to ink colour.
        accent: '#0a0a0a',
        // accent-2 = success state (sync ok, schedule active)
        'accent-2': '#16a34a',   // green-600
        // accent-soft = error state surface
        'accent-soft': '#fef2f2', // red-50
        tag: '#71717a',          // metadata text (zinc-500)
        // Garden maturity dots — kept colours since these are functional
        // signal (idea state), not editorial decoration. The names stay so
        // existing bg-olive / bg-gold / bg-plum still work.
        olive: '#7a8a3f',
        gold: '#c98a2b',
        plum: '#5b4f88',
      },
      fontFamily: {
        // Fraunces is gone. `serif` aliases to Inter so any leftover
        // font-serif class falls back to sans cleanly during the migration
        // (we'll sweep the JSX in follow-up commits).
        serif: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        tightest: '-0.025em',
        tighter: '-0.018em',
        editorial: '-0.012em',
      },
      // Rounded scale from Sprint 12 — kept name-stable, values bumped a
      // touch toward Ghostbase's softer feel.
      borderRadius: {
        soft: '8px',   // inputs, small buttons
        card: '12px',  // sidebar nav pills, content cards
        panel: '16px', // larger panels, connector cards
        modal: '20px', // settings modal, full-screen overlays
      },
      boxShadow: {
        // Subtle hover lift used on cards.
        soft: '0 1px 2px rgba(0, 0, 0, 0.04), 0 1px 4px rgba(0, 0, 0, 0.03)',
        // Modal float — heavier than soft, still understated.
        modal:
          '0 10px 30px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04)',
      },
    },
  },
  plugins: [],
};

export default config;
