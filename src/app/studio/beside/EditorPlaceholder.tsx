// Thoughtbed · Beside EditorPlaceholder
//
// Phase 24 slice 1 (2026-05-07). The center pane while real Tiptap
// is still off the table. A textarea inside PlatformFrame so
// Payton can see the platform-shaped writing surface (LinkedIn
// card, blog body, newsletter column, etc.) and type into it.
// Prose lives in component state and disappears on reload —
// slice 2 or 3 swaps in real Tiptap with the existing
// ThoughtBubble extension.

'use client';

import { useState } from 'react';
import { PlatformFrame } from '../page/PlatformFrame';

export function EditorPlaceholder({ topic }: { topic: string }) {
  const [text, setText] = useState('');

  return (
    <div className="px-6 md:px-10 py-10 md:py-14">
      <PlatformFrame>
        <div className="flex flex-col gap-3">
          <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag">
            Topic
          </p>
          <h2 className="font-sans text-[20px] leading-[1.3] tracking-tightest text-ink">
            {topic}
          </h2>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Start writing here. The real editor lands in a later slice — for now, this is just to show the platform shape."
            rows={14}
            className="mt-2 w-full bg-transparent border border-rule rounded-soft px-3 py-2.5 font-sans text-[15px] leading-[1.6] text-ink placeholder:text-tag outline-none focus:border-rule-strong resize-y min-h-[300px]"
          />
          <p className="font-mono text-[9px] tracking-[0.14em] uppercase text-tag">
            Slice 2: real Tiptap · Slice 3: pull-as-bubble · Slice 4: Reshape
          </p>
        </div>
      </PlatformFrame>
    </div>
  );
}
