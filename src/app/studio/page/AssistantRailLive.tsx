// Folio · AssistantRailLive
//
// Sprint 8: the right pane on /studio/page/[id]. Wires the Sprint 7
// retrieval substrate into the writing surface — as the user types, we
// debounce the editor's text, call findSimilar against captures + ideas +
// drafts, and surface the top hits as pull-able rows.
//
// Design tenets carried over from the rest of the studio:
//   · "from you, not for you" — retrieval is remembering, not search.
//     Empty/sparse states should feel calm, not broken.
//   · Editorial restraint — Fraunces for content, JetBrains Mono for
//     system labels, single-character glyphs as decoration.
//   · Sacred saves — the rail is observational. It never blocks the
//     editor and never holds onto input focus.
//
// Pull behaviour: clicking a row inserts the source text into the editor
// at the current selection. Captures and drafts insert as a blockquote
// (you're working from someone else's words — your own past words count).
// Ideas insert as an H2 + a paragraph for the essence (you're picking up
// a thread of your own thinking).

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorContext } from './EditorContext';
import { findSimilar, type SimilarHit } from '../actions';

const DEBOUNCE_MS = 1500;
const MIN_QUERY_CHARS = 12;
const MAX_QUERY_CHARS = 4000;
const RESULT_LIMIT = 6;

const KIND_GLYPH: Record<SimilarHit['kind'], string> = {
  capture: '"',
  idea: '▸',
  draft: '✎',
};

const KIND_LABEL: Record<SimilarHit['kind'], string> = {
  capture: 'capture',
  idea: 'idea',
  draft: 'draft',
};

type Status =
  | { kind: 'idle' } // waiting for enough text
  | { kind: 'loading' }
  | { kind: 'ok'; hits: SimilarHit[]; basedOnChars: number }
  | { kind: 'empty'; basedOnChars: number }
  | { kind: 'error'; message: string };

export function AssistantRailLive({ draftId }: { draftId: string }) {
  const { editor } = useEditorContext();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // Refs for debounced retrieval. We don't store the timer ID in state to
  // avoid re-renders on every keystroke; we only set state when retrieval
  // results change.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stamps the latest retrieval call. If a newer one starts before this
  // one finishes, the older one's setStatus is ignored — same idea as
  // the editor's coalesced saves.
  const queryStampRef = useRef(0);

  const runRetrieval = useCallback(
    async (text: string) => {
      const stamp = ++queryStampRef.current;
      setStatus({ kind: 'loading' });
      try {
        const hits = await findSimilar({
          text,
          kinds: ['capture', 'idea', 'draft'],
          limit: RESULT_LIMIT,
          excludeDraftId: draftId,
        });
        if (stamp !== queryStampRef.current) return;
        if (hits.length === 0) {
          setStatus({ kind: 'empty', basedOnChars: text.length });
        } else {
          setStatus({ kind: 'ok', hits, basedOnChars: text.length });
        }
      } catch (err) {
        if (stamp !== queryStampRef.current) return;
        const message = err instanceof Error ? err.message : 'retrieval failed';
        setStatus({ kind: 'error', message });
      }
    },
    [draftId]
  );

  // Subscribe to editor updates. Each `update` event triggers a debounced
  // retrieval call against the editor's current plain text.
  useEffect(() => {
    if (!editor) return;

    const trigger = () => {
      const text = editor.getText().trim().slice(0, MAX_QUERY_CHARS);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (text.length < MIN_QUERY_CHARS) {
        // Not enough signal — go idle and cancel any inflight retrieval.
        queryStampRef.current++;
        setStatus({ kind: 'idle' });
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        runRetrieval(text);
      }, DEBOUNCE_MS);
    };

    // Run once on mount so a draft you load with existing content
    // immediately surfaces neighbours.
    trigger();
    editor.on('update', trigger);
    return () => {
      editor.off('update', trigger);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, runRetrieval]);

  // Click handler: insert the hit's content into the editor at the cursor
  // position. Captures + drafts → blockquote (working from words). Ideas
  // → H2 + paragraph (picking up your own thinking).
  const onPull = useCallback(
    (hit: SimilarHit) => {
      if (!editor) return;
      const chain = editor.chain().focus();

      if (hit.kind === 'idea') {
        const titleNode = hit.title
          ? {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: hit.title }],
            }
          : null;
        const essenceNode = hit.snippet
          ? {
              type: 'paragraph',
              content: [{ type: 'text', text: hit.snippet }],
            }
          : null;
        const nodes = [titleNode, essenceNode].filter(Boolean) as object[];
        if (nodes.length === 0) return;
        chain.insertContent(nodes).run();
        return;
      }

      // captures + drafts → blockquote with the body / snippet text.
      const text = hit.snippet?.trim() || hit.title?.trim();
      if (!text) return;
      chain
        .insertContent({
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text }],
            },
          ],
        })
        .run();
    },
    [editor]
  );

  return (
    <aside
      className="border-l border-rule bg-paper/40 flex flex-col"
      aria-label="Assistant"
    >
      <div className="px-5 pt-6 pb-4 border-b border-rule">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-3">
          ▸ The closed loop
        </div>
        <p className="font-serif italic text-[14px] text-ink-soft leading-[1.5]">
          What your bank is humming with — pulled as you write. Click a row
          to drop it into the draft.
        </p>
      </div>

      <div className="flex-1 px-5 py-6 overflow-y-auto">
        <BodyForStatus status={status} onPull={onPull} />
      </div>

      <div className="px-5 py-3 border-t border-rule font-mono text-[10px] tracking-[0.16em] uppercase text-tag/80 flex items-center gap-2">
        <FootnoteForStatus status={status} />
      </div>
    </aside>
  );
}

function BodyForStatus({
  status,
  onPull,
}: {
  status: Status;
  onPull: (hit: SimilarHit) => void;
}) {
  switch (status.kind) {
    case 'idle':
      return (
        <div className="flex flex-col items-start gap-3">
          <span className="inline-block font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 border border-rule rounded-full px-3 py-1">
            Listening
          </span>
          <p className="font-serif italic text-[13px] text-tag leading-[1.55]">
            Start writing. Once a sentence or two lands, the Assistant will
            surface what your captures and earlier drafts already have to say
            about it.
          </p>
        </div>
      );

    case 'loading':
      return (
        <p className="font-serif italic text-[13px] text-tag leading-[1.55]">
          remembering<span className="opacity-60">…</span>
        </p>
      );

    case 'empty':
      return (
        <div className="flex flex-col items-start gap-3">
          <span className="inline-block font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 border border-rule rounded-full px-3 py-1">
            Quiet
          </span>
          <p className="font-serif italic text-[13px] text-tag leading-[1.55]">
            Nothing in your bank is resonating with this yet. Keep going —
            the assistant remembers more as you capture more.
          </p>
        </div>
      );

    case 'error':
      return (
        <p
          className="font-serif italic text-[13px] text-accent leading-[1.55]"
          title={status.message}
        >
          Couldn't reach the Assistant just now. Keep typing — it'll try again.
        </p>
      );

    case 'ok':
      return (
        <ul className="flex flex-col gap-1">
          {status.hits.map((hit) => (
            <li key={`${hit.kind}-${hit.id}`}>
              <HitRow hit={hit} onPull={onPull} />
            </li>
          ))}
        </ul>
      );
  }
}

function HitRow({
  hit,
  onPull,
}: {
  hit: SimilarHit;
  onPull: (hit: SimilarHit) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPull(hit)}
      className="w-full text-left rounded-[3px] px-2 py-3 -mx-2 hover:bg-paper-2 transition-colors group focus:outline-none focus:ring-1 focus:ring-accent/40"
    >
      <div className="flex items-baseline gap-2 font-mono text-[10px] tracking-[0.16em] uppercase text-tag mb-1">
        <span className="text-accent" aria-hidden>
          {KIND_GLYPH[hit.kind]}
        </span>
        <span>{KIND_LABEL[hit.kind]}</span>
        <span className="ml-auto text-tag/70 normal-case tracking-[0.04em]">
          · {hit.similarity.toFixed(2)}
        </span>
      </div>
      {hit.title && (
        <div className="font-serif text-[14px] text-ink leading-[1.4] group-hover:text-accent transition-colors">
          {hit.title}
        </div>
      )}
      {hit.snippet && (
        <div
          className={`font-serif text-[13px] text-ink-soft leading-[1.55] ${hit.title ? 'mt-1' : ''} line-clamp-3`}
        >
          {hit.snippet}
        </div>
      )}
      <div className="mt-2 font-mono text-[9px] tracking-[0.22em] uppercase text-tag/70 opacity-0 group-hover:opacity-100 transition-opacity">
        + pull into draft
      </div>
    </button>
  );
}

function FootnoteForStatus({ status }: { status: Status }) {
  switch (status.kind) {
    case 'idle':
      return <span>· waiting for ink</span>;
    case 'loading':
      return <span>· retrieving</span>;
    case 'ok':
      return (
        <span>
          · {status.hits.length} based on {status.basedOnChars} chars
        </span>
      );
    case 'empty':
      return <span>· nothing matched ({status.basedOnChars} chars)</span>;
    case 'error':
      return <span className="text-accent">· retrieval offline</span>;
  }
}
