'use client';

/**
 * src/app/studio/BackfillButton.tsx
 *
 * Generic one-click backfill trigger used on /studio.
 *
 * Wave 2: reused for both backfillEmbeddings and backfillExtractedIdeas
 * by passing different `action` and `label` props.
 */

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';

interface BackfillButtonProps {
  /** The server action to invoke when the button is clicked. */
  action: () => Promise<{
    ok: boolean;
    processed: number;
    skipped:   number;
    errors:    string[];
  }>;
  /** Button label in the idle state. */
  label: string;
}

export function BackfillButton({ action, label }: BackfillButtonProps) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{
    ok: boolean;
    processed: number;
    skipped: number;
    errors: string[];
  } | null>(null);

  function handleClick() {
    start(async () => {
      const r = await action();
      setResult(r);
    });
  }

  return (
    <div className="space-y-2">
      <Button onClick={handleClick} disabled={pending}>
        {pending ? 'Running…' : label}
      </Button>

      {result && (
        <p className={`text-sm ${
          result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'
        }`}>
          {result.ok ? 'Done' : 'Partial'} — {result.processed} processed,{' '}
          {result.skipped} skipped
          {result.errors.length > 0 && (
            <span> · {result.errors.length} error(s): {result.errors[0]}</span>
          )}
        </p>
      )}
    </div>
  );
}
