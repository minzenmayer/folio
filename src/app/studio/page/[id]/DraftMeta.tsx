// Folio · DraftMeta
// Small chrome above the editor — title (from first H1, surfaced from the DB)
// and a discreet delete action. Kept intentionally quiet to match the
// editorial tone of the writing surface.

'use client';

import { useState, useTransition } from 'react';
import { deleteDraft } from '../actions';

export function DraftMeta({
  title,
  updatedAt,
  draftId,
}: {
  title: string | null;
  updatedAt: Date | string | null;
  draftId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  const handleDelete = () => {
    if (!confirming) {
      setConfirming(true);
      // Auto-cancel after 4s if the user doesn't click again.
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    startTransition(async () => {
      await deleteDraft({ draftId });
    });
  };

  const updated =
    updatedAt instanceof Date
      ? updatedAt
      : updatedAt
        ? new Date(updatedAt)
        : null;

  return (
    <header className="flex items-baseline justify-between gap-6 border-b border-rule pb-4">
      <div className="min-w-0">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-2">
          ▸ Draft
        </div>
        <h1
          className={`font-serif text-[22px] leading-[1.2] truncate ${
            title ? 'text-ink' : 'italic text-tag font-light'
          }`}
        >
          {title || 'Untitled — start with an H1'}
        </h1>
      </div>

      <div className="flex items-center gap-4 flex-shrink-0">
        {updated && (
          <span className="font-mono text-[10px] tracking-[0.04em] text-tag whitespace-nowrap">
            {updated.toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
        )}
        <button
          type="button"
          onClick={handleDelete}
          disabled={pending}
          className={`font-sans text-[10px] tracking-[0.18em] uppercase transition-colors disabled:opacity-40 ${
            confirming
              ? 'text-accent hover:text-ink'
              : 'text-tag hover:text-accent'
          }`}
          aria-label={confirming ? 'Confirm delete draft' : 'Delete draft'}
        >
          {pending
            ? 'Deleting…'
            : confirming
              ? 'Click to confirm'
              : 'Delete'}
        </button>
      </div>
    </header>
  );
}
