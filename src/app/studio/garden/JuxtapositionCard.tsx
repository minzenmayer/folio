// Phase 14b — one slot in the daily digest reserved for a system-generated
// juxtaposition: two ideas paired with a provocation question.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { claimTension, showAnotherJuxtaposition, dismissJuxtaposition } from './actions';

export function JuxtapositionCard({
  id,
  question,
  reasoning,
  leftTitle,
  rightTitle,
}: {
  id: string;
  question: string;
  reasoning: string;
  leftTitle: string;
  rightTitle: string;
  heuristic: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  function handle(action: 'claim' | 'another' | 'dismiss') {
    setBusy(action);
    start(async () => {
      if (action === 'claim') {
        const r = await claimTension(id);
        if ('newIdeaId' in r) router.push(`/studio/garden/${r.newIdeaId}`);
      } else if (action === 'another') {
        await showAnotherJuxtaposition(id);
        router.refresh();
      } else if (action === 'dismiss') {
        await dismissJuxtaposition(id);
        router.refresh();
      }
      setBusy(null);
    });
  }

  return (
    <div className="rounded-card p-4 border border-[#7F77DD] bg-[#EEEDFE]">
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#3C3489] font-medium mb-2">
        Provocation · today
      </div>
      <h3 className="font-serif text-[16px] font-medium leading-[1.35] text-[#26215C] mb-3">
        {question}
      </h3>

      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-stretch mb-3">
        <div className="bg-paper border border-rule rounded-md p-2">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-tag mb-1">
            Idea A
          </div>
          <div className="font-sans text-[12px] font-medium leading-[1.35] text-ink">
            {leftTitle}
          </div>
        </div>
        <div className="font-mono text-[11px] text-[#534AB7] flex items-center px-1 tracking-[0.14em]">
          ↔
        </div>
        <div className="bg-paper border border-rule rounded-md p-2">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-tag mb-1">
            Idea B
          </div>
          <div className="font-sans text-[12px] font-medium leading-[1.35] text-ink">
            {rightTitle}
          </div>
        </div>
      </div>

      <p className="text-[12px] italic text-[#3C3489] leading-[1.55] mb-3">
        ↳ {reasoning}
      </p>

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => handle('claim')}
          disabled={pending}
          className="font-sans text-[12px] px-3 py-[6px] rounded-md bg-[#534AB7] text-white border border-[#534AB7] disabled:opacity-50"
        >
          {busy === 'claim' ? 'Claiming…' : 'Claim the tension'}
        </button>
        <button
          onClick={() => handle('another')}
          disabled={pending}
          className="font-sans text-[12px] px-3 py-[6px] rounded-md bg-paper text-[#26215C] border border-[#7F77DD] disabled:opacity-50"
        >
          {busy === 'another' ? 'Loading…' : 'Show me another'}
        </button>
        <button
          onClick={() => handle('dismiss')}
          disabled={pending}
          className="font-sans text-[12px] px-3 py-[6px] rounded-md bg-transparent text-[#3C3489] border border-transparent hover:underline disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
