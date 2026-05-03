// Thoughtbed · Masthead
// Top bar for every page. Italic Thoughtbed wordmark on the left,
// optional contextual text on the right.

import Link from 'next/link';

interface MastheadProps {
  rightSlot?: React.ReactNode;
}

export function Masthead({ rightSlot }: MastheadProps) {
  return (
    <header className="border-b border-rule">
      <div className="max-w-[1200px] mx-auto px-[7%] py-7 flex justify-between items-baseline gap-4">
        <Link
          href="/"
          className="font-serif italic text-[22px] text-ink font-medium hover:text-accent transition-colors"
          aria-label="Thoughtbed — home"
        >
          Thoughtbed
        </Link>
        <div className="font-sans text-[11px] sm:text-[12px] uppercase tracking-[0.18em] text-tag whitespace-nowrap">
          {rightSlot ?? 'Mature your mind'}
        </div>
      </div>
    </header>
  );
}
