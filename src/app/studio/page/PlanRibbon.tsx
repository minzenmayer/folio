// Thoughtbed · PlanRibbon
//
// Phase 16 slice 6 (2026-05-05). The editor's right pane gains a Plan
// zone above the existing Resonance zone (AssistantRailLive). PlanRibbon
// reads the live Tiptap doc's H2 nodes — each carrying data-tb-beat-id
// + data-tb-beat-status stamped at compile time by commitProposal —
// and renders one pill per beat. Pills carry their fill state from
// the status:
//
//   anchored (filled green)         user pinned this beat in the spar
//   drafted (outline green)         beat has user-drafted prose
//   floating (paper / rule)         beat exists but neither anchored
//                                   nor drafted
//
// Clicking a pill scrolls the editor to its H2 and briefly highlights
// it. If the user deletes the H2, the pill disappears on the next
// re-render (we recompute from doc state, not stored state).
//
// No new schema. State derives entirely from the Tiptap doc; the rail
// has no persistent memory of its own. Stateless across sessions per
// the Phase 16 spec.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useEditorContext } from './EditorContext';
import { useRailCollapse } from './useRailCollapse';

type BeatPill = {
  id: string;
  beat: string;
  status: 'anchored' | 'drafted' | 'floating';
  pos: number;
};

export function PlanRibbon() {
  const { editor } = useEditorContext();
  // Phase 20 slice 6: PlanRibbon shares the rail's collapse state. When
  // the user collapses or hides the rail, the ribbon goes with it — both
  // surfaces are in the same right column and the spec calls them out
  // as one unit.
  const { state: collapseState } = useRailCollapse();
  // We don't subscribe to editor.state directly — instead we bump a
  // local tick counter on transactions so React re-renders.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => setTick((t) => t + 1);
    editor.on('transaction', onUpdate);
    return () => {
      editor.off('transaction', onUpdate);
    };
  }, [editor]);

  const pills = useMemo<BeatPill[]>(() => {
    if (!editor) return [];
    const out: BeatPill[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'heading') return;
      if (node.attrs.level !== 2) return;
      const id = node.attrs['data-tb-beat-id'];
      const status = node.attrs['data-tb-beat-status'];
      if (!id) return;
      out.push({
        id,
        beat: node.textContent,
        status:
          status === 'anchored' || status === 'drafted' || status === 'floating'
            ? status
            : 'floating',
        pos,
      });
    });
    return out;
    // The tick counter forces re-derive on every editor transaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, tick]);

  if (!editor) return null;
  if (pills.length === 0) {
    // Empty state — drafts that didn't come through the spar (legacy
    // drafts pre-Phase-16, or drafts created via the escape-hatch
    // "Just open a blank page →") have no beat metadata. Don't render
    // a header that would just be a label without content.
    return null;
  }
  // Phase 20 slice 6: hide alongside the rail when collapsed/hidden.
  if (collapseState !== 'expanded') return null;

  return (
    <aside
      aria-label="Plan ribbon. Anchored beats from the spar."
      className="border-b border-rule px-5 py-4 bg-paper-2"
    >
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
          Plan
        </h3>
        <p className="font-mono text-[10px] tracking-[0.04em] text-tag">
          {pills.length} {pills.length === 1 ? 'beat' : 'beats'}
        </p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {pills.map((p, i) => (
          <li key={p.id}>
            <PlanPill pill={p} index={i} />
          </li>
        ))}
      </ul>
      {/* Phase 16 slice 8 polish: Replan affordance. Links back to
          /studio so the user can start a fresh spar without losing
          the editor (browser back / new tab keeps the draft alive).
          Seeding the spar from the draft's anchors is a future-phase
          improvement; v2 ships with the link only. */}
      <div className="mt-3 pt-3 border-t border-rule">
        <Link
          href="/studio"
          className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors"
          title="Open the spar to rethink the plan"
        >
          ↻ Replan
        </Link>
      </div>
    </aside>
  );
}

function PlanPill({ pill, index }: { pill: BeatPill; index: number }) {
  const { editor } = useEditorContext();
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fill =
    pill.status === 'anchored'
      ? 'bg-[#dcfce7] border-[#15803d] text-[#14532d]'
      : pill.status === 'drafted'
        ? 'bg-paper border-[#15803d] text-ink'
        : 'bg-paper border-rule text-ink-soft hover:border-ink/40';

  const onClick = () => {
    if (!editor) return;
    // Scroll the doc node into view + briefly pulse the pill so the
    // user sees the connection between rail and editor.
    try {
      const dom = editor.view.nodeDOM(pill.pos);
      if (dom && dom instanceof HTMLElement) {
        dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch {
      // nodeDOM throws if the node has been removed mid-render. Pill
      // will disappear on the next transaction; do nothing.
    }
    setPulse(true);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setPulse(false), 800);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Scroll to beat ${index + 1} (${pill.status})`}
      className={`w-full text-left rounded-soft border px-3 py-2 transition-colors ${fill} ${pulse ? 'ring-2 ring-[#15803d]' : ''}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] tracking-[0.04em] text-tag font-medium shrink-0">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="font-sans text-[12.5px] leading-[1.4] line-clamp-2 break-words">
          {pill.beat || '(empty)'}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1 font-mono text-[9px] tracking-[0.18em] uppercase text-tag">
        <StatusGlyph status={pill.status} />
        <span>{statusLabel(pill.status)}</span>
      </div>
    </button>
  );
}

function statusLabel(status: BeatPill['status']): string {
  if (status === 'anchored') return 'Anchored';
  if (status === 'drafted') return 'Drafted';
  return 'Floating';
}

function StatusGlyph({ status }: { status: BeatPill['status'] }) {
  if (status === 'anchored') {
    // filled dot
    return (
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        <circle cx="4" cy="4" r="3" fill="currentColor" />
      </svg>
    );
  }
  if (status === 'drafted') {
    // checkmark
    return (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  // floating — small open dot
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
      <circle cx="4" cy="4" r="2.5" fill="none" stroke="currentColor" />
    </svg>
  );
}
