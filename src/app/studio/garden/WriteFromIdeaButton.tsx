// Thoughtbed · WriteFromIdeaButton — Phase 19.x (2026-05-06)
//
// One-click hand-off from a Garden card into the editor. Server
// action `composeFromIdea` builds a fresh draft seeded with the
// idea's title (H1) + essence, then redirects into the editor.
//
// Usage: drop this on ClusterCard, GardenFeed list rows, and any
// expand surface where the user might say "okay, I want to write
// on this." Two visual variants:
//   - default: small monospace pill, fits next to other actions.
//   - prominent: filled paper-3 button, used on the expand surface
//     when there's room for a real CTA.

'use client';

import { useTransition } from 'react';
import { composeFromIdea } from './actions';

type Props = {
  kind: 'idea' | 'extracted_idea';
  id: string;
  variant?: 'default' | 'prominent';
  className?: string;
};

export function WriteFromIdeaButton({
  kind,
  id,
  variant = 'default',
  className = '',
}: Props) {
  const [pending, start] = useTransition();

  function go(e: React.MouseEvent) {
    // Stop click bubbling so the card's outer Link doesn't fire.
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    start(async () => {
      try {
        await composeFromIdea(kind, id);
      } catch (err) {
        // redirect() throws NEXT_REDIRECT internally — that's the
        // happy path for server actions calling redirect. Anything
        // else is a real error we should log.
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('NEXT_REDIRECT')) {
          console.warn('[WriteFromIdeaButton] failed', err);
        }
      }
    });
  }

  if (variant === 'prominent') {
    return (
      <button
        type="button"
        onClick={go}
        disabled={pending}
        className={`font-sans text-[13px] font-medium text-ink bg-paper-3 border border-rule rounded-pill px-4 py-2 hover:bg-paper-2 hover:border-ink-soft disabled:opacity-50 transition-colors ${className}`}
      >
        {pending ? 'Opening editor…' : 'Write from this idea →'}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={pending}
      className={`font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink disabled:opacity-50 transition-colors ${className}`}
      title="Open a new draft pre-seeded with this idea"
    >
      {pending ? 'Opening…' : 'Write →'}
    </button>
  );
}
