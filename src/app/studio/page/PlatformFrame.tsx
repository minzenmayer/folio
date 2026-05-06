// Thoughtbed · PlatformFrame
//
// Phase 21 slice 4 (2026-05-06). Visual frame around the editor body
// shaped to match the active platform. The underlying Tiptap doc is
// the same across frames; only the wrapper changes. Switching
// platforms doesn't transform content — the user keeps writing the
// same prose, just inside a different visual context.
//
//   linkedin   → 520px max-width card with avatar + name + meta at
//                top, Like/Comment/Share row at the bottom. Sans
//                body, ~14px.
//   newsletter → serif body, 68ch column, generous leading. The
//                editor's existing prose styling already matches;
//                no extra chrome.
//   blog       → wider editorial body (~80ch), serif, slightly
//                larger heading rhythm.
//   note       → no frame. The default editor surface.
//
// Slice 5 wires a desktop/mobile preview toggle that further
// narrows the frame width when 'mobile' is active. Slice 6's chat
// companion sees the same platform via usePlatform.

'use client';

import { type ReactNode } from 'react';
import { usePlatform } from './usePlatform';

export function PlatformFrame({ children }: { children: ReactNode }) {
  const { platform, previewWidth } = usePlatform();
  // Phase 21 slice 5: when previewWidth === 'mobile', clamp the
  // outer width to a phone-ish 380px regardless of the platform's
  // natural width. The inner per-platform chrome stays the same.
  const mobileClass = previewWidth === 'mobile' ? 'max-w-[380px]' : '';

  if (platform === 'linkedin') {
    return (
      <div className={`max-w-[520px] mx-auto ${mobileClass}`}>
        <div className="rounded-card border border-rule bg-paper px-5 py-5 shadow-soft">
          <div className="flex items-center gap-3 mb-4">
            <div
              aria-hidden="true"
              className="w-10 h-10 rounded-full bg-paper-2 border border-rule flex items-center justify-center font-mono text-[11px] tracking-[0.04em] text-tag font-medium"
            >
              You
            </div>
            <div className="leading-tight">
              <p className="font-sans text-[13px] font-medium text-ink m-0">
                Your name
              </p>
              <p className="font-sans text-[11px] text-tag m-0">
                LinkedIn preview · now
              </p>
            </div>
          </div>
          <div className="font-sans text-[14px] leading-[1.55] text-ink linkedin-frame">
            {children}
          </div>
          <div className="mt-4 pt-3 border-t border-rule flex items-center gap-5 font-sans text-[12px] text-tag">
            <span>Like</span>
            <span>Comment</span>
            <span>Repost</span>
            <span>Send</span>
          </div>
        </div>
      </div>
    );
  }

  if (platform === 'blog') {
    return (
      <div className={`max-w-[80ch] mx-auto blog-frame ${mobileClass}`}>
        {children}
      </div>
    );
  }

  // 'newsletter' and 'note' — the editor's existing prose styling
  // already matches the newsletter shape; note is the same as
  // newsletter without the topic-as-H1 emphasis. No extra chrome.
  return (
    <div className={`max-w-[68ch] mx-auto ${mobileClass}`}>{children}</div>
  );
}
