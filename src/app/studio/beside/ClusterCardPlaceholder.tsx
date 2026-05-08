// Thoughtbed · Beside ClusterCardPlaceholder
//
// Phase 24 slice 1 (2026-05-07). Visual stand-in for the real
// ClusterCard that lands in slice 2. Renders the spec's "collapsed
// default with top-fragment preview + count" shape with hand-fed
// data so Payton can react to the panel layout before any
// findSimilar wiring exists.
//
// Click expands locally; expand reveals the additional fragments.
// No retrieval, no claim writes.

'use client';

import { useState } from 'react';

export type Fragment = {
  id: string;
  text: string;
};

export type ClusterPlaceholder = {
  id: string;
  title: string;
  fragments: ReadonlyArray<Fragment>;
};

export function ClusterCardPlaceholder({
  cluster,
}: {
  cluster: ClusterPlaceholder;
}) {
  const [open, setOpen] = useState(false);
  const top = cluster.fragments[0];
  const remaining = cluster.fragments.length - 1;

  return (
    <div className="rounded-card border border-rule bg-paper">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left px-3 py-2.5 flex flex-col gap-1.5"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag">
            {cluster.title}
          </span>
          <span className="font-mono text-[10px] text-tag">
            {open ? '−' : '+'}
          </span>
        </div>
        {top && (
          <p className="font-sans text-[13px] leading-[1.45] text-ink-soft line-clamp-2">
            "{top.text}"
          </p>
        )}
        {!open && remaining > 0 && (
          <span className="font-mono text-[10px] text-tag">
            + {remaining} more
          </span>
        )}
      </button>
      {open && cluster.fragments.length > 1 && (
        <ul className="border-t border-rule px-3 py-2 space-y-2">
          {cluster.fragments.slice(1).map((f) => (
            <li
              key={f.id}
              className="font-sans text-[13px] leading-[1.45] text-ink-soft"
            >
              "{f.text}"
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
