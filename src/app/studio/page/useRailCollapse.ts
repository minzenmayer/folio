// Thoughtbed · useRailCollapse
//
// Phase 20 slice 6 (2026-05-06). Three-state collapse for the editor's
// right rail, persisted to localStorage so the choice sticks across
// sessions. Lifted out of AssistantRailLive so the rail and PlanRibbon
// can read the same state — collapsing hides both per the spec.
//
//   expanded   — default at >=1024px. Full rail at the route's grid width.
//   collapsed  — 56px strip showing only the top-3 idea glyphs + chevron.
//                Click any glyph to expand AND scroll the matching pill
//                into view (caller wires the scroll target).
//   hidden     — fully gone. Today this maps onto the existing self-pilot
//                dormant mode (the rail's own Off toggle governs it). The
//                chevron only cycles between expanded and collapsed; the
//                hidden value is read by the rail when it wants to show
//                the 'Wake up resonance' affordance in a future slice.
//
// localStorage key 'tb:railCollapse'. Older versions of the app didn't
// write this key, so the first read falls back to 'expanded'.

'use client';

import { useCallback, useEffect, useState } from 'react';

export type RailCollapseState = 'expanded' | 'collapsed' | 'hidden';

const STORAGE_KEY = 'tb:railCollapse';

function readStored(): RailCollapseState {
  if (typeof window === 'undefined') return 'expanded';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'collapsed' || raw === 'hidden' || raw === 'expanded') {
      return raw;
    }
  } catch {
    // localStorage may throw in private mode / strict cookie settings.
  }
  return 'expanded';
}

const SYNC_EVENT = 'tb:railCollapse:change';

function writeStored(value: RailCollapseState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Ignore — the rail still works with in-memory state.
  }
  // Broadcast to other consumers in the same tab. localStorage's native
  // 'storage' event only fires across tabs.
  try {
    window.dispatchEvent(
      new CustomEvent<RailCollapseState>(SYNC_EVENT, { detail: value })
    );
  } catch {
    // Older browsers without CustomEvent are out of scope.
  }
}

export function useRailCollapse(initial?: RailCollapseState): {
  state: RailCollapseState;
  setState: (next: RailCollapseState) => void;
  /**
   * Cycle between expanded and collapsed (the chevron toggle). Leaves
   * 'hidden' alone — that state is reached via the self-pilot Off
   * toggle, not the chevron.
   */
  toggleCollapsed: () => void;
} {
  // Render with an initial value first; hydrate from localStorage on mount
  // so we don't break the SSR/CSR HTML contract.
  const [state, setRaw] = useState<RailCollapseState>(initial ?? 'expanded');

  useEffect(() => {
    setRaw(readStored());

    function onSync(e: Event) {
      const detail = (e as CustomEvent<RailCollapseState>).detail;
      if (detail === 'collapsed' || detail === 'expanded' || detail === 'hidden') {
        setRaw(detail);
      }
    }
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      const v = e.newValue;
      if (v === 'collapsed' || v === 'expanded' || v === 'hidden') {
        setRaw(v);
      }
    }
    window.addEventListener(SYNC_EVENT, onSync as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SYNC_EVENT, onSync as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setState = useCallback((next: RailCollapseState) => {
    setRaw(next);
    writeStored(next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setRaw((prev) => {
      const next: RailCollapseState =
        prev === 'collapsed' ? 'expanded' : 'collapsed';
      writeStored(next);
      return next;
    });
  }, []);

  return { state, setState, toggleCollapsed };
}
