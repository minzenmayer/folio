// Folio · DraftMeta
// Small chrome above the editor — title (from first H1, surfaced from the DB),
// last-updated timestamp, an overflow menu with exports + history, and a
// discreet click-to-confirm delete. Kept intentionally quiet to match the
// editorial tone of the writing surface.
//
// The overflow menu (S6 wave 4) needs the live Tiptap editor instance for
// exports (getJSON / getHTML). The parent (EditorPane) lifts the editor
// instance up and passes it in — null while the editor is mounting. We
// disable export actions until it lands.

'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type { Editor } from '@tiptap/react';
import { deleteDraft, publishDraftToBeehiiv } from '../actions';
import type { PublishToBeehiivResult } from '../publish-types';
import {
  tiptapJsonToMarkdown,
  tiptapJsonToText,
  htmlForExport,
  downloadFile,
  safeFilename,
} from '@/lib/exports';

export function DraftMeta({
  title,
  updatedAt,
  draftId,
  editor,
  onOpenHistory,
}: {
  title: string | null;
  updatedAt: Date | string | null;
  draftId: string;
  // Live Tiptap editor instance. Null until DraftEditor mounts; export
  // actions are disabled while null.
  editor: Editor | null;
  // Parent toggle for the History modal.
  onOpenHistory: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyFlash, setCopyFlash] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  // Sprint 15 Wave 4 / Phase 6: Beehiiv outbound publish state.
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] =
    useState<PublishToBeehiivResult | null>(null);

  const handleDelete = () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    startTransition(async () => {
      await deleteDraft({ draftId });
    });
  };

  // Sprint 15 Wave 4 / Phase 6: publish current draft to Beehiiv as a
  // draft post. Beehiiv-side review and send happens in their UI; we
  // never auto-send.
  const handlePublishToBeehiiv = async () => {
    setMenuOpen(false);
    setPublishing(true);
    setPublishResult(null);
    try {
      const result = await publishDraftToBeehiiv({ draftId });
      setPublishResult(result);
      setTimeout(() => setPublishResult(null), 8000);
    } finally {
      setPublishing(false);
    }
  };

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (
        menuWrapRef.current &&
        !menuWrapRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  const filenameBase = safeFilename(title, draftId.slice(0, 8));

  const closeMenu = () => setMenuOpen(false);

  const copyAsMarkdown = useCallback(async () => {
    if (!editor) return;
    const md = tiptapJsonToMarkdown(editor.getJSON());
    try {
      await navigator.clipboard.writeText(md);
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1500);
    } catch (err) {
      console.error('[DraftMeta] clipboard write failed', err);
    }
    closeMenu();
  }, [editor]);

  const downloadMarkdown = useCallback(() => {
    if (!editor) return;
    const md = tiptapJsonToMarkdown(editor.getJSON());
    downloadFile(`${filenameBase}.md`, md, 'text/markdown;charset=utf-8');
    closeMenu();
  }, [editor, filenameBase]);

  const downloadHtml = useCallback(() => {
    if (!editor) return;
    const html = htmlForExport(editor.getHTML(), title);
    downloadFile(`${filenameBase}.html`, html, 'text/html;charset=utf-8');
    closeMenu();
  }, [editor, filenameBase, title]);

  const downloadTextFile = useCallback(() => {
    if (!editor) return;
    const txt = tiptapJsonToText(editor.getJSON());
    downloadFile(`${filenameBase}.txt`, txt, 'text/plain;charset=utf-8');
    closeMenu();
  }, [editor, filenameBase]);

  const showHistory = useCallback(() => {
    closeMenu();
    onOpenHistory();
  }, [onOpenHistory]);

  const updated =
    updatedAt instanceof Date
      ? updatedAt
      : updatedAt
        ? new Date(updatedAt)
        : null;

  const exportsDisabled = !editor;

  return (
    <header className="flex items-baseline justify-between gap-6 border-b border-rule pb-4">
      <div className="min-w-0">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold">
          ▸ Draft
        </div>
        {/* Phase 14a (2026-05-04): the static H1 title display moved into
            <TitleInput> below this header. The chrome here is now meta +
            menu + delete only. */}
      </div>

      <div className="flex items-center gap-4 flex-shrink-0">
        {updated && (
          <span className="font-mono text-[10px] tracking-[0.04em] text-tag whitespace-nowrap">
            {updated.toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
        )}

        {copyFlash && (
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-accent">
            · copied
          </span>
        )}

        {publishResult?.ok && (
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-accent">
            · drafted on beehiiv
            {publishResult.postUrl && (
              <a
                className="ml-2 underline underline-offset-2 hover:text-ink"
                href={publishResult.postUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                open ↗
              </a>
            )}
          </span>
        )}
        {publishResult && !publishResult.ok && (
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag">
            · {publishResult.message}
          </span>
        )}

        <div ref={menuWrapRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="font-sans text-[14px] text-tag hover:text-accent transition-colors px-2"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            ···
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-2 bg-paper border border-rule rounded-[3px] shadow-lg z-20 min-w-[220px] overflow-hidden"
            >
              <MenuItem
                onClick={copyAsMarkdown}
                disabled={exportsDisabled}
                label="Copy as Markdown"
              />
              <MenuItem
                onClick={downloadMarkdown}
                disabled={exportsDisabled}
                label="Download .md"
              />
              <MenuItem
                onClick={downloadHtml}
                disabled={exportsDisabled}
                label="Download .html"
              />
              <MenuItem
                onClick={downloadTextFile}
                disabled={exportsDisabled}
                label="Download .txt"
              />
              <MenuDivider />
              <MenuItem onClick={showHistory} label="Show history" />
              <MenuDivider />
              <MenuItem
                onClick={handlePublishToBeehiiv}
                disabled={publishing}
                label={publishing ? 'Publishing…' : 'Publish to Beehiiv'}
              />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleDelete}
          disabled={pending}
          className={`font-sans text-[10px] tracking-[0.18em] uppercase transition-colors disabled:opacity-40 ${
            confirming
              ? 'text-accent hover:text-ink'
              : 'text-tag hover:text-accent'
          }`}
          aria-label={confirming ? 'Confirm delete draft' : 'Delete draft'}
        >
          {pending
            ? 'Deleting…'
            : confirming
              ? 'Click to confirm'
              : 'Delete'}
        </button>
      </div>
    </header>
  );
}

function MenuItem({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="block w-full text-left px-4 py-2 font-sans text-[12px] tracking-[0.04em] text-ink-soft hover:bg-paper-2 hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-soft"
    >
      {label}
    </button>
  );
}

function MenuDivider() {
  return <div className="border-t border-rule" aria-hidden="true" />;
}
