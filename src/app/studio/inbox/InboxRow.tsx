// Thoughtbed · InboxRow
// Sprint 14 brand pivot: monochrome restyle, drop type-glyph chip.

'use client';

import { useState, useTransition } from 'react';
import {
  attachToIdea,
  discardCapture,
  promoteToNewIdea,
  stashCapture,
} from './actions';
import type { Capture, Idea } from '@/db';

interface InboxRowProps {
  capture: Capture;
  ideas: Pick<Idea, 'id' | 'title'>[];
}

function timeAgo(date: Date | string | null): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

export function InboxRow({ capture, ideas }: InboxRowProps) {
  const [open, setOpen] = useState(false);
  const [newIdeaTitle, setNewIdeaTitle] = useState('');
  const [showPromote, setShowPromote] = useState(false);
  const [pending, startTransition] = useTransition();

  const handleAttach = (ideaId: string) => {
    startTransition(async () => {
      await attachToIdea({ captureId: capture.id, ideaId });
      setOpen(false);
    });
  };

  const handlePromote = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newIdeaTitle.trim();
    if (!title) return;
    startTransition(async () => {
      await promoteToNewIdea({ captureId: capture.id, ideaTitle: title });
    });
  };

  const handleStash = () => {
    startTransition(async () => {
      await stashCapture({ captureId: capture.id });
    });
  };

  const handleDiscard = () => {
    startTransition(async () => {
      await discardCapture({ captureId: capture.id });
    });
  };

  return (
    <li
      className={`transition-colors ${
        open ? 'bg-paper-2' : 'hover:bg-paper-2/60'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left flex items-start gap-4 px-5 py-4"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          <div className="font-sans text-[14.5px] text-ink leading-[1.55] line-clamp-3">
            {capture.body}
          </div>
          <div className="font-mono text-[10px] text-tag mt-2 tracking-[0.04em]">
            {capture.source && (
              <>
                <span>{capture.source}</span>
                <span className="mx-2">·</span>
              </>
            )}
            <span className="uppercase">{capture.capturedVia}</span>
            <span className="mx-2">·</span>
            <span>{timeAgo(capture.capturedAt)}</span>
          </div>
        </div>
        <span className="flex-shrink-0 font-mono text-[12px] text-tag pt-1">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          {ideas.length > 0 && (
            <div>
              <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium mb-2">
                Attach to existing idea
              </div>
              <div className="flex flex-wrap gap-2">
                {ideas.map((idea) => (
                  <button
                    key={idea.id}
                    onClick={() => handleAttach(idea.id)}
                    disabled={pending}
                    className="px-3 py-1.5 border border-rule rounded-soft bg-paper hover:bg-paper-2 hover:border-ink font-sans text-[13px] text-ink-soft hover:text-ink transition-colors disabled:opacity-40"
                  >
                    {idea.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium mb-2">
              Or, promote to a new idea
            </div>
            {showPromote ? (
              <form onSubmit={handlePromote} className="flex gap-2">
                <input
                  autoFocus
                  value={newIdeaTitle}
                  onChange={(e) => setNewIdeaTitle(e.target.value)}
                  placeholder="What's this idea called?"
                  className="flex-1 bg-paper border border-rule rounded-soft px-3 py-2 font-sans text-[13.5px] text-ink placeholder:text-tag focus:outline-none focus:border-ink"
                />
                <button
                  type="submit"
                  disabled={pending || !newIdeaTitle.trim()}
                  className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft transition-colors disabled:opacity-40"
                >
                  {pending ? '…' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPromote(false)}
                  className="px-3 font-sans text-[12px] text-tag hover:text-ink"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                onClick={() => setShowPromote(true)}
                className="font-sans text-[13px] text-ink hover:underline underline-offset-4 decoration-rule-strong"
              >
                + Create a new idea from this capture →
              </button>
            )}
          </div>

          <div className="flex gap-4 pt-2 border-t border-rule">
            <button
              onClick={handleStash}
              disabled={pending}
              className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors disabled:opacity-40"
            >
              Stash for later
            </button>
            <button
              onClick={handleDiscard}
              disabled={pending}
              className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors disabled:opacity-40 ml-auto"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
