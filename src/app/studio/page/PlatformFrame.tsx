// Thoughtbed · PlatformFrame
//
// Phase 21 slice 4 (2026-05-06). Visual frame around the editor
// body shaped to match the active platform.
//
// Phase 22 slice 3 (2026-05-06): respects three view modes.
//   editor  ('desktop')   — plain editable surface, no chrome
//   preview ('preview')   — full platform render (LinkedIn card
//                           with avatar + reactions + comments +
//                           Like/Comment/Repost/Send), READ-ONLY
//   mobile  ('mobile')    — narrow phone-width render of the
//                           preview shape

'use client';

import { type ReactNode } from 'react';
import { usePlatform } from './usePlatform';

export function PlatformFrame({ children }: { children: ReactNode }) {
  const { platform, previewWidth } = usePlatform();
  const isMobile = previewWidth === 'mobile';
  const isPreview = previewWidth === 'preview' || isMobile;
  const mobileClass = isMobile ? 'max-w-[380px]' : '';

  if (platform === 'linkedin' && isPreview) {
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
          <div className="mt-4 pt-3 border-t border-rule flex items-center gap-4 text-tag font-sans text-[12px]">
            <span className="flex items-center gap-1"><LikeGlyph /> 237</span>
            <span>· 26 comments</span>
            <span>· 11 reposts</span>
          </div>
          <div className="mt-2 pt-2 border-t border-rule flex items-center gap-5 text-tag font-sans text-[12px]">
            <span>Like</span>
            <span>Comment</span>
            <span>Repost</span>
            <span>Send</span>
          </div>
        </div>
      </div>
    );
  }

  if (platform === 'linkedin') {
    return (
      <div className={`max-w-[520px] mx-auto ${mobileClass}`}>
        <div className="rounded-card border border-rule bg-paper px-5 py-5">
          <div className="font-sans text-[14px] leading-[1.55] text-ink linkedin-frame">
            {children}
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

  return (
    <div className={`max-w-[68ch] mx-auto ${mobileClass}`}>{children}</div>
  );
}

function LikeGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M3 5.5 L4.5 5.5 L4.5 9.5 L3 9.5 Z M5.2 5.5 L7.5 5.5 C8.3 5.5 8.8 5.9 8.7 6.6 L8.4 8.5 C8.3 9.1 7.8 9.5 7.2 9.5 L5.2 9.5 Z M5.5 4.8 C5.5 4 5.8 3 6.4 2.6 C6.7 2.4 7 2.5 7.1 2.8 L7.3 4.5 L8.2 4.5 L7.5 4.5 L8.7 4.5 L8 4.5 L7.6 4.7 Z" />
    </svg>
  );
}
