// Thoughtbed · ViewToggle — Phase 17 (2026-05-05)
//
// Top-right toggle on the Garden surface. Flips between cluster view
// (default) and flat list. Persists per user via localStorage so the
// choice rides with their browser.
//
// Implementation is purely client-side: state lives in a query param
// (?view=list / ?view=cluster) that the page reads server-side. The
// localStorage value is a hint for the next visit; the page reads the
// query param if present, otherwise falls back to localStorage on the
// next render.

'use client';

import { useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

const STORAGE_KEY = 'tb_garden_view';

export function ViewToggle({
  active,
}: {
  active: 'cluster' | 'list';
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  // Persist the active view so the next visit boots in the same shape.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, active);
    } catch {
      // ignore
    }
  }, [active]);

  // On first load, if no ?view= param is set, read localStorage and
  // (re)route once. Avoids forcing the user to pick the view every
  // time they revisit the Garden.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sp.get('view')) return;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && stored !== active && (stored === 'cluster' || stored === 'list')) {
        const params = new URLSearchParams(sp.toString());
        params.set('view', stored);
        router.replace(`${pathname}?${params.toString()}`);
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function go(target: 'cluster' | 'list') {
    const params = new URLSearchParams(sp.toString());
    params.set('view', target);
    router.replace(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="inline-flex items-center gap-1 rounded-soft border border-rule bg-paper p-1">
      <button
        type="button"
        onClick={() => go('cluster')}
        aria-pressed={active === 'cluster'}
        className={`font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-2.5 py-1 transition-colors ${
          active === 'cluster'
            ? 'bg-ink text-bg'
            : 'text-tag hover:text-ink hover:bg-paper-2'
        }`}
      >
        Clusters
      </button>
      <button
        type="button"
        onClick={() => go('list')}
        aria-pressed={active === 'list'}
        className={`font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-2.5 py-1 transition-colors ${
          active === 'list'
            ? 'bg-ink text-bg'
            : 'text-tag hover:text-ink hover:bg-paper-2'
        }`}
      >
        List
      </button>
    </div>
  );
}
