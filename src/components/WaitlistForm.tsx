// Folio · WaitlistForm
// Email capture for the studio-opening-soon state.
// No server action wired yet — Phase 5 (Sprint 2) will connect this to a real list.
// For now: optimistic local state, "thank you" surface on submit.

'use client';

import { useState } from 'react';

interface WaitlistFormProps {
  variant?: 'hero' | 'closing';
}

export function WaitlistForm({ variant = 'hero' }: WaitlistFormProps) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'submitted'>('idle');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) return;
    // TODO Phase 5: POST to /api/waitlist
    setState('submitted');
  };

  if (state === 'submitted') {
    return (
      <div
        className={`mx-auto ${
          variant === 'hero' ? 'max-w-[480px]' : 'max-w-[420px]'
        }`}
        role="status"
      >
        <div className="bg-paper border border-rule rounded-[3px] px-6 py-7 text-center">
          <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-3">
            ▸ You're on the list
          </div>
          <p className="font-serif italic text-[18px] text-ink leading-[1.45]">
            We'll write when the studio opens.
          </p>
          <p className="font-sans text-[12px] text-tag mt-3">
            Saved: <span className="font-mono text-ink">{email}</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`mx-auto ${
        variant === 'hero' ? 'max-w-[480px]' : 'max-w-[420px]'
      }`}
    >
      <div className="flex flex-col sm:flex-row gap-2 bg-paper border border-rule rounded-[3px] p-2">
        <input
          type="email"
          required
          placeholder="your@email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email address"
          className="flex-1 px-4 py-3 bg-transparent font-serif text-[16px] text-ink placeholder:text-tag placeholder:italic focus:outline-none"
        />
        <button
          type="submit"
          className="px-5 py-3 bg-ink text-bg font-sans text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] hover:bg-accent transition-colors whitespace-nowrap"
        >
          Join the list
        </button>
      </div>
      <p className="font-sans text-[11px] text-tag mt-3 text-center tracking-[0.04em]">
        We'll only write when the studio opens. No newsletters between now and
        then.
      </p>
    </form>
  );
}
