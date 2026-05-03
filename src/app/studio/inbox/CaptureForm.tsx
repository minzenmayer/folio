// Folio · CaptureForm
// Paste-based capture surface. Sprint 3 v0 — minimal, fast, the cheapest action
// in the product.

'use client';

import { useState, useTransition } from 'react';
import { createCapture } from './actions';

export function CaptureForm() {
  const [body, setBody] = useState('');
  const [source, setSource] = useState('');
  const [pending, startTransition] = useTransition();
  const [showSourceField, setShowSourceField] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    startTransition(async () => {
      await createCapture({
        body,
        source: source.trim() || undefined,
      });
      setBody('');
      setSource('');
      setShowSourceField(false);
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-paper border border-rule rounded-card shadow-soft"
    >
      <div className="px-6 pt-5 pb-3">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-3">
          ☘ Plant a seed
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Paste a thought, a quote, an excerpt. Anything you don't want to lose."
          rows={4}
          className="w-full resize-none bg-transparent font-serif text-[17px] text-ink placeholder:text-tag placeholder:italic placeholder:font-light leading-[1.55] focus:outline-none"
          aria-label="Seed body"
        />
      </div>

      {showSourceField && (
        <div className="px-6 pb-2">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Source (optional) — URL, person, book, anywhere"
            className="w-full bg-paper-2 border border-rule rounded-soft px-3 py-2 font-sans text-[13px] text-ink-soft placeholder:text-tag placeholder:italic focus:outline-none focus:border-accent"
          />
        </div>
      )}

      <div className="px-5 py-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setShowSourceField((s) => !s)}
          className="font-sans text-[12px] text-tag hover:text-accent transition-colors"
        >
          {showSourceField ? '— hide source' : '+ add source'}
        </button>
        <div className="flex items-center gap-3">
          <span className="font-sans text-[11px] text-tag">
            {body.length > 0 && `${body.length} chars`}
          </span>
          <button
            type="submit"
            disabled={pending || !body.trim()}
            className="px-4 py-2 bg-ink text-bg font-sans text-[12px] font-medium rounded-soft hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? 'Planting…' : '⏎ Plant'}
          </button>
        </div>
      </div>
    </form>
  );
}
