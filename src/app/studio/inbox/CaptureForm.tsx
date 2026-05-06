// Thoughtbed · CaptureForm
// Paste-based capture surface. Sprint 14 brand pivot: monochrome restyle,
// drop "Plant a seed" copy.

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
      className="bg-paper border border-rule rounded-card"
    >
      <div className="px-5 pt-4 pb-2">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
          New capture
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Paste a thought, a quote, an excerpt. Anything you don't want to lose."
          rows={4}
          className="w-full resize-none bg-transparent font-sans text-[15.5px] leading-[1.55] text-ink placeholder:text-tag focus:outline-none"
          aria-label="Capture body"
        />
      </div>

      {showSourceField && (
        <div className="px-5 pb-2">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Source (optional). URL, person, book, anywhere"
            className="w-full bg-paper-2 border border-rule rounded-soft px-3 py-2 font-sans text-[13px] text-ink-soft placeholder:text-tag focus:outline-none focus:border-ink"
          />
        </div>
      )}

      <div className="px-5 py-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setShowSourceField((s) => !s)}
          className="font-sans text-[12.5px] text-tag hover:text-ink transition-colors"
        >
          {showSourceField ? '− Hide source' : '+ Add source'}
        </button>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-tag tracking-[0.04em]">
            {body.length > 0 && `${body.length} chars`}
          </span>
          <button
            type="submit"
            disabled={pending || !body.trim()}
            className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors"
          >
            {pending ? 'Saving…' : 'Capture'}
          </button>
        </div>
      </div>
    </form>
  );
}
