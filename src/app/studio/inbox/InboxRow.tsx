// Folio · InboxRow
// A single capture in the Inbox list. Type-coded glyph, body preview, source,
// and the four-way promotion path on hover/click.

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

const TYPE_GLYPHS: Record<string, string> = {
  paste: '"',
  link: '↗',
  quote: '"',
  image: '▣',
  voice_memo: '◉',
  doc: '▭',
  feed_item: '⌁',
};

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

  const glyph = TYPE_GLYPHS[capture.type] ?? '·';

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
    <div
      className={`border-b border-rule transition-colors ${
        open ? 'bg-paper' : 'hover:bg-paper/50'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left flex items-start gap-4 px-2 py-5"
        aria-expanded={open}
      >
        <span className="flex-shrink-0 w-8 h-8 rounded-[3px] bg-paper-2 border border-rule flex items-center justify-center text-[14px] text-accent font-mono mt-0.5">
          {glyph}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-serif text-[16px] text-ink leading-[1.5] line-clamp-3">
            {capture.body}
          </div>
          <div className="font-sans text-[11px] text-tag mt-2 tracking-[0.04em]">
            {capture.source && (
              <>
                <span className="italic">{capture.source}</span>
                <span className="mx-2">·</span>
              </>
            )}
            <span className="font-mono">{capture.capturedVia}</span>
            <span className="mx-2">·</span>
            <span>{timeAgo(capture.capturedAt)}</span>
          </div>
        </div>
        <span className="flex-shrink-0 font-mono text-[10px] text-tag pt-1 self-center">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="px-12 pb-6 space-y-4">
          {/* Attach to existing idea */}
          {ideas.length > 0 && (
            <div>
              <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-bold mb-2">
                ▸ Attach to existing idea
              </div>
              <div className="flex flex-wrap gap-2">
                {ideas.map((idea) => (
                  <button
                    key={idea.id}
                    onClick={() => handleAttach(idea.id)}
                    disabled={pending}
                    className="px-3 py-1.5 border border-rule-strong rounded-[3px] font-serif text-[14px] text-ink-soft hover:border-accent hover:text-accent transition-colors disabled:opacity-40"
                  >
                    {idea.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Promote to new idea */}
          <div>
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-bold mb-2">
              ▸ Or — promote to a new idea
            </div>
            {showPromote ? (
              <form onSubmit={handlePromote} className="flex gap-2">
                <input
                  autoFocus
                  value={newIdeaTitle}
                  onChange={(e) => setNewIdeaTitle(e.target.value)}
                  placeholder="What's this idea called?"
                  className="flex-1 bg-bg border border-rule-strong rounded-[3px] px-3 py-2 font-serif text-[14px] text-ink placeholder:text-tag placeholder:italic focus:outline-none focus:border-accent"
                />
                <button
                  type="submit"
                  disabled={pending || !newIdeaTitle.trim()}
                  className="px-4 py-2 bg-accent text-bg font-sans text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] hover:bg-ink transition-colors disabled:opacity-40"
                >
                  {pending ? '…' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPromote(false)}
                  className="px-3 font-sans text-[11px] text-tag hover:text-ink"
                >
                  cancel
                </button>
              </form>
            ) : (
              <button
                onClick={() => setShowPromote(true)}
                className="font-serif italic text-[14px] text-accent hover:underline underline-offset-4"
              >
                + Create a new idea from this capture →
              </button>
            )}
          </div>

          {/* Stash / discard */}
          <div className="flex gap-4 pt-2 border-t border-rule">
            <button
              onClick={handleStash}
              disabled={pending}
              className="font-sans text-[11px] tracking-[0.18em] uppercase text-tag hover:text-ink-soft transition-colors disabled:opacity-40"
            >
              ◇ Stash for later
            </button>
            <button
              onClick={handleDiscard}
              disabled={pending}
              className="font-sans text-[11px] tracking-[0.18em] uppercase text-tag hover:text-accent transition-colors disabled:opacity-40 ml-auto"
            >
              ✕ Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
