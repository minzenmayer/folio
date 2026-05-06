// Thoughtbed · EditorToolbar
//
// Phase 21 slice 3 (2026-05-06). Top toolbar for the editor route.
// Carries the document actions Payton flagged from Ghostbase: save
// to favorites, download as markdown, copy to clipboard, history.
// Live word-count readout sits next to the actions; slice 4 wires
// the platform-shape toggle on the left side and updates the
// word-count target per platform.
//
// Favorites for slice 3 are stored in localStorage under the key
// 'tb:fav:<draftId>'. A real DB-backed favorites column can come
// later; this gets the UX shipping without a migration.

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useEditorContext } from './EditorContext';
import { HistoryModal } from './[id]/HistoryModal';
import {
  tiptapJsonToMarkdown,
  downloadFile,
  safeFilename,
} from '@/lib/exports';
import {
  usePlatform,
  PLATFORMS,
  PLATFORM_LABEL,
  PLATFORM_WORD_TARGET,
  type Platform,
  type PreviewWidth,
} from './usePlatform';

const FAV_KEY_PREFIX = 'tb:fav:';

function readFavorite(draftId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(`${FAV_KEY_PREFIX}${draftId}`) === '1';
  } catch {
    return false;
  }
}

function writeFavorite(draftId: string, value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      window.localStorage.setItem(`${FAV_KEY_PREFIX}${draftId}`, '1');
    } else {
      window.localStorage.removeItem(`${FAV_KEY_PREFIX}${draftId}`);
    }
  } catch {
    // Ignore.
  }
}

export function EditorToolbar({
  draftId,
  title,
}: {
  draftId: string;
  title: string | null;
}) {
  const { editor } = useEditorContext();
  const [favorited, setFavorited] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copyFlash, setCopyFlash] = useState(false);
  const [downloadFlash, setDownloadFlash] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setFavorited(readFavorite(draftId));
  }, [draftId]);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => setTick((t) => t + 1);
    editor.on('update', onUpdate);
    return () => {
      editor.off('update', onUpdate);
    };
  }, [editor]);

  const wordCount = useMemo(() => {
    if (!editor) return 0;
    const text = editor.getText().trim();
    if (text.length === 0) return 0;
    return text.split(/\s+/).length;
    // tick re-runs the memo on every editor update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, tick]);

  function toggleFavorite() {
    const next = !favorited;
    setFavorited(next);
    writeFavorite(draftId, next);
  }

  async function copyAsMarkdown() {
    if (!editor) return;
    const md = tiptapJsonToMarkdown(editor.getJSON());
    try {
      await navigator.clipboard.writeText(md);
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1500);
    } catch {
      // Clipboard may be blocked; fall back to a download.
      downloadAsMarkdown();
    }
  }

  function downloadAsMarkdown() {
    if (!editor) return;
    const md = tiptapJsonToMarkdown(editor.getJSON());
    const filename = safeFilename(title, draftId);
    downloadFile(`${filename}.md`, md, 'text/markdown;charset=utf-8');
    setDownloadFlash(true);
    setTimeout(() => setDownloadFlash(false), 1500);
  }

  return (
    <>
      <div className="px-5 py-2.5 flex items-center justify-between gap-3">
        <PlatformToggle />

        <div className="flex items-center gap-3">
          <WordCountReadout count={wordCount} />
          <PreviewWidthToggle />

          <div className="flex items-center gap-1">
            <ToolbarIconButton
              ariaLabel={favorited ? 'Remove from favorites' : 'Save to favorites'}
              title={favorited ? 'Remove from favorites' : 'Save to favorites'}
              onClick={toggleFavorite}
              active={favorited}
            >
              {favorited ? (
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path
                    d="M7 1.6l1.7 3.45 3.8.55-2.75 2.68.65 3.78L7 10.27 3.6 12.06l.65-3.78L1.5 5.6l3.8-.55Z"
                    fill="currentColor"
                  />
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M7 1.6l1.7 3.45 3.8.55-2.75 2.68.65 3.78L7 10.27 3.6 12.06l.65-3.78L1.5 5.6l3.8-.55Z" />
                </svg>
              )}
            </ToolbarIconButton>

            <ToolbarIconButton
              ariaLabel="Download as markdown"
              title={downloadFlash ? 'Downloaded' : 'Download as markdown'}
              onClick={downloadAsMarkdown}
              flash={downloadFlash}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M7 2v7.4" />
                <polyline points="3.8 6.2 7 9.4 10.2 6.2" />
                <line x1="2.5" y1="11.5" x2="11.5" y2="11.5" />
              </svg>
            </ToolbarIconButton>

            <ToolbarIconButton
              ariaLabel="Copy to clipboard"
              title={copyFlash ? 'Copied' : 'Copy to clipboard'}
              onClick={copyAsMarkdown}
              flash={copyFlash}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="4" y="3" width="7" height="9" rx="1.2" />
                <path d="M9 3V2.2A1 1 0 0 0 8 1.2H4A1 1 0 0 0 3 2.2V10" />
              </svg>
            </ToolbarIconButton>

            <ToolbarIconButton
              ariaLabel="History"
              title="History"
              onClick={() => setHistoryOpen(true)}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="2 4 2 7 5 7" />
                <path d="M2 7a5 5 0 1 0 1.5-3.5" />
                <polyline points="7 4.5 7 7.5 9.2 8.5" />
              </svg>
            </ToolbarIconButton>
          </div>
        </div>
      </div>

      {historyOpen && editor && (
        <HistoryModal
          draftId={draftId}
          editor={editor}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>
  );
}

function ToolbarIconButton({
  children,
  ariaLabel,
  title,
  onClick,
  active,
  flash,
}: {
  children: React.ReactNode;
  ariaLabel: string;
  title: string;
  onClick: () => void;
  active?: boolean;
  flash?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      className={`p-1.5 rounded-soft transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong ${
        active
          ? 'text-glyph-hot hover:text-glyph-hot/80'
          : flash
            ? 'text-accent-2'
            : 'text-tag hover:text-ink hover:bg-paper-2'
      }`}
    >
      {children}
    </button>
  );
}

// Phase 21 slice 4 (2026-05-06): segmented platform control.
// Left and right arrows cycle through linkedin / newsletter / blog
// / note. Clicking a label sets directly. The active platform's
// label gets a paper-2 fill + ink text; others read as muted.
function PlatformToggle() {
  const { platform, setPlatform, cycle } = usePlatform();
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => cycle('left')}
        aria-label="Previous platform"
        title="Previous platform"
        className="text-tag hover:text-ink transition-colors p-1 rounded-soft focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="7,2 3,6 7,10" />
        </svg>
      </button>
      <div className="flex items-center gap-0.5" role="tablist" aria-label="Platform shape">
        {PLATFORMS.map((p) => (
          <PlatformChip
            key={p}
            value={p}
            active={p === platform}
            onClick={() => setPlatform(p)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => cycle('right')}
        aria-label="Next platform"
        title="Next platform"
        className="text-tag hover:text-ink transition-colors p-1 rounded-soft focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="5,2 9,6 5,10" />
        </svg>
      </button>
    </div>
  );
}

function PlatformChip({
  value,
  active,
  onClick,
}: {
  value: Platform;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`font-mono text-[10px] tracking-[0.16em] uppercase rounded-full px-2.5 py-1 transition-colors border ${
        active
          ? 'bg-paper-2 text-ink border-rule'
          : 'bg-transparent text-tag border-transparent hover:text-ink hover:bg-paper-2'
      }`}
    >
      {PLATFORM_LABEL[value]}
    </button>
  );
}

function WordCountReadout({ count }: { count: number }) {
  const { platform } = usePlatform();
  const target = PLATFORM_WORD_TARGET[platform];
  if (target === null) {
    return (
      <span
        className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag"
        aria-live="polite"
      >
        {count} {count === 1 ? 'word' : 'words'}
      </span>
    );
  }
  // Color drift: under target = tag, near target (>=80%) = ink, over
  // target = accent (a soft signal, not an alarm).
  const ratio = count / target;
  const cls =
    ratio >= 1.1
      ? 'text-accent'
      : ratio >= 0.8
        ? 'text-ink'
        : 'text-tag';
  return (
    <span
      className={`font-mono text-[10px] tracking-[0.18em] uppercase ${cls}`}
      aria-live="polite"
      title={`Target: ~${target} words for ${PLATFORM_LABEL[platform]}`}
    >
      {count} / ~{target} words
    </span>
  );
}

// Phase 22 slice 3 (2026-05-06): three-mode toggle — preview /
// editor / mobile. Eye icon = full platform render (LinkedIn
// reactions, comments, etc.). Desktop icon = plain editable.
// Phone icon = narrow rendered preview.
function PreviewWidthToggle() {
  const { previewWidth, setPreviewWidth } = usePlatform();
  return (
    <div
      role="group"
      aria-label="View mode"
      className="flex items-center gap-0.5 border border-rule rounded-full p-0.5"
    >
      <PreviewWidthChip
        value="preview"
        active={previewWidth === 'preview'}
        onClick={() => setPreviewWidth('preview')}
      />
      <PreviewWidthChip
        value="desktop"
        active={previewWidth === 'desktop'}
        onClick={() => setPreviewWidth('desktop')}
      />
      <PreviewWidthChip
        value="mobile"
        active={previewWidth === 'mobile'}
        onClick={() => setPreviewWidth('mobile')}
      />
    </div>
  );
}

function PreviewWidthChip({
  value,
  active,
  onClick,
}: {
  value: PreviewWidth;
  active: boolean;
  onClick: () => void;
}) {
  const label =
    value === 'preview'
      ? 'Rendered preview'
      : value === 'desktop'
        ? 'Editor view'
        : 'Mobile preview';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`p-1 rounded-full transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-rule-strong ${
        active
          ? 'bg-paper-2 text-ink'
          : 'text-tag hover:text-ink'
      }`}
    >
      {value === 'preview' ? (
        <EyeGlyph />
      ) : value === 'desktop' ? (
        <DesktopGlyph />
      ) : (
        <MobileGlyph />
      )}
    </button>
  );
}

function EyeGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 7C3 4 5 3 7 3C9 3 11 4 12.5 7C11 10 9 11 7 11C5 11 3 10 1.5 7Z" />
      <circle cx="7" cy="7" r="1.6" />
    </svg>
  );
}

function DesktopGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="10" height="6.5" rx="1" />
      <line x1="5" y1="12" x2="9" y2="12" />
      <line x1="7" y1="9.5" x2="7" y2="12" />
    </svg>
  );
}

function MobileGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="2" width="6" height="10" rx="1" />
      <line x1="6" y1="10.5" x2="8" y2="10.5" />
    </svg>
  );
}

