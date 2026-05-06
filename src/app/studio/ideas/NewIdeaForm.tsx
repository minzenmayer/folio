// Thoughtbed · NewIdeaForm
// Sprint 14 brand pivot: monochrome restyle.

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
      className="bg-paper border border-rule rounded-card"
    >
      <div className="px-5 pt-4 pb-3">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
          New idea
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title. Your shorthand for this idea"
          className="w-full bg-transparent font-sans text-[18px] font-medium text-ink placeholder:text-tag focus:outline-none"
          aria-label="Idea title"
        />
      </div>

      {showEssence && (
        <div className="px-5 pb-3">
          <textarea
            value={essence}
            onChange={(e) => setEssence(e.target.value)}
            placeholder="Essence. One or two sentences. What is this, in your own words?"
            rows={3}
            className="w-full resize-none bg-paper-2 border border-rule rounded-soft px-3 py-2 font-sans text-[14px] text-ink-soft placeholder:text-tag focus:outline-none focus:border-ink leading-[1.5]"
          />
        </div>
      )}

      <div className="px-5 py-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setShowEssence((s) => !s)}
          className="font-sans text-[12.5px] text-tag hover:text-ink transition-colors"
        >
          {showEssence ? '− Hide essence' : '+ Add essence'}
        </button>
        <button
          type="submit"
          disabled={pending || !title.trim()}
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors"
        >
          {pending ? 'Creating…' : 'Create idea'}
        </button>
      </div>
    </form>
  );
}
