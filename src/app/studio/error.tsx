// Thoughtbed · Studio error boundary
//
// Catches any throw from /studio/* server components and renders a
// readable surface with the error message + a retry button. Far
// better than Next.js's generic 'server-side exception' card,
// which gives the user no path forward.

'use client';

import { useEffect } from 'react';

export default function StudioError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[studio/error]', error);
  }, [error]);

  return (
    <section>
      <div className="max-w-[640px] mx-auto px-6 md:px-8 py-16">
        <h1 className="font-sans text-[28px] font-semibold tracking-tight text-ink mb-3">
          Something didn&apos;t load.
        </h1>
        <p className="font-sans text-[15px] text-ink-soft leading-[1.55] mb-6">
          A piece of the studio threw an error. The rest of the system
          should still work — try reloading, or visit a different
          surface from the sidebar.
        </p>
        <div className="rounded-card border border-rule bg-paper-2 px-4 py-3 mb-6 font-mono text-[12px] text-ink-soft leading-[1.5] break-words">
          <div className="text-tag uppercase tracking-[0.18em] text-[10px] mb-1">
            Error
          </div>
          {error.message || 'Unknown error.'}
          {error.digest && (
            <div className="text-tag mt-2 text-[10px]">
              Digest: {error.digest}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft transition-colors"
          >
            Try again
          </button>
          <a
            href="/studio/inbox"
            className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-soft px-4 py-2 border border-rule hover:border-ink hover:bg-paper-2 transition-colors text-ink-soft"
          >
            Inbox →
          </a>
        </div>
      </div>
    </section>
  );
}
