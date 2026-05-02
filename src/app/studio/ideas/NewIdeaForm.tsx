// Folio · NewIdeaForm
// Quick path to spawn an idea from the Library, no capture required.

'use client';

import { useState, useTransition } from 'react';
import { createIdea } from './actions';

export function NewIdeaForm() {
  const [title, setTitle] = useState('');
  const [essence, setEssence] = useState('');
  const [showEssence, setShowEssence] = useState(false);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    startTransition(async () => {
      await createIdea({ title, essence: essence.trim() || undefined });
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-paper border border-rule rounded-[3px]"
    >
      <div className="px-6 pt-5 pb-3">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-3">
          ▸ New idea
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title — your shorthand for this idea"
          className="w-full bg-transparent font-serif text-[20px] text-ink placeholder:text-tag placeholder:italic placeholder:font-light focus:outline-none"
          aria-label="Idea title"
        />
      </div>

      {showEssence && (
        <div className="px-6 pb-3">
          <textarea
            value={essence}
            onChange={(e) => setEssence(e.target.value)}
            placeholder="Essence — one or two sentences. What is this, in your own words?"
            rows={3}
            className="w-full resize-none bg-bg border border-rule rounded-[3px] px-3 py-2 font-serif italic text-[15px] text-ink-soft placeholder:text-tag placeholder:italic focus:outline-none focus:border-accent leading-[1.5]"
          />
        </div>
      )}

      <div className="border-t border-rule px-6 py-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setShowEssence((s) => !s)}
          className="font-sans text-[11px] tracking-[0.04em] text-tag hover:text-accent transition-colors"
        >
          {showEssence ? '— hide essence' : '+ add essence'}
        </button>
        <button
          type="submit"
          disabled={pending || !title.trim()}
          className="px-4 py-2 bg-accent text-bg font-sans text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] hover:bg-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? 'Creating…' : '⏎ Create idea'}
        </button>
      </div>
    </form>
  );
}
