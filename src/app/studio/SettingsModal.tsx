// Thoughtbed · SettingsModal
//
// Sprint 14 brand pivot — Settings is now an overlay modal, not a route.
// Matches the Ghostbase pattern where Voice ID, Custom Instructions,
// Memories etc. all live inside a centred white modal with a small left
// nav and close X top-right.
//
// State source = the URL searchParam `settings`:
//   ?settings=connectors  → modal open, Connectors panel selected
//   (no param)            → modal closed
//
// Why URL state vs React state:
//   · The sidebar Settings link can be anywhere in /studio and just push
//     `?settings=connectors`; Next handles the navigation.
//   · Deep-links and refresh-while-open both work for free.
//   · ESC + close-X both push back to the current path without query —
//     the route stays the same, only the param drops.
//
// Sections currently:
//   · connectors  → Beehiiv connect / sync / disconnect (Wave 1 of S13).
//   Future: voice, custom-instructions, memories, profile, billing, usage.

'use client';

import { useCallback, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ConnectorsPanel } from './settings/ConnectorsPanel';

const SECTIONS = [
  { id: 'connectors', label: 'Connectors', enabled: true },
  { id: 'voice', label: 'Voice ID', enabled: false },
  { id: 'instructions', label: 'Custom Instructions', enabled: false },
  { id: 'memories', label: 'Memories', enabled: false },
  { id: 'billing', label: 'Billing', enabled: false },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function isSection(value: string | null): value is SectionId {
  if (!value) return false;
  return SECTIONS.some((s) => s.id === value);
}

export function SettingsModal() {
  const router = useRouter();
  const pathname = usePathname() ?? '/studio';
  const searchParams = useSearchParams();
  const requested = searchParams?.get('settings') ?? null;
  const open = isSection(requested);
  const section: SectionId = open ? (requested as SectionId) : 'connectors';

  const close = useCallback(() => {
    // Strip the settings param while keeping any others.
    const next = new URLSearchParams(searchParams ?? undefined);
    next.delete('settings');
    const tail = next.toString();
    router.push(`${pathname}${tail ? `?${tail}` : ''}`, { scroll: false });
  }, [pathname, router, searchParams]);

  // ESC closes the modal — standard expectation.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Body scroll lock while the modal is open. Restored on close.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      {/* Backdrop — click to close */}
      <button
        type="button"
        aria-label="Close settings"
        onClick={close}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[1px] cursor-default"
      />

      {/* Panel */}
      <div className="relative bg-paper rounded-modal shadow-modal w-full max-w-[1100px] h-[min(800px,90vh)] flex overflow-hidden">
        {/* Internal left nav */}
        <nav
          aria-label="Settings sections"
          className="w-[220px] shrink-0 border-r border-rule px-3 py-6 flex flex-col gap-1"
        >
          <div className="px-3 pb-3 font-sans text-[16px] font-semibold tracking-tight text-ink">
            Thoughtbed
          </div>
          <div className="px-3 pb-2 font-sans text-[11px] text-tag uppercase tracking-[0.18em]">
            Space
          </div>
          {SECTIONS.map((s) => {
            const active = s.id === section;
            const baseClass =
              'flex items-center justify-between rounded-soft px-3 py-2 font-sans text-[13.5px] transition-colors';
            if (!s.enabled) {
              return (
                <div
                  key={s.id}
                  className={`${baseClass} text-tag/70 cursor-not-allowed`}
                >
                  <span>{s.label}</span>
                  <span className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag/70">
                    soon
                  </span>
                </div>
              );
            }
            return (
              <Link
                key={s.id}
                href={`${pathname}?settings=${s.id}`}
                scroll={false}
                className={`${baseClass} ${
                  active
                    ? 'bg-paper-2 text-ink font-medium'
                    : 'text-ink-soft hover:bg-paper-2 hover:text-ink'
                }`}
              >
                <span>{s.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right pane — scrollable content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-start justify-between px-8 pt-7 pb-4 border-b border-rule">
            <div>
              <h2
                id="settings-title"
                className="font-sans text-[20px] font-semibold tracking-tight text-ink"
              >
                {SECTIONS.find((s) => s.id === section)?.label}
              </h2>
              <p className="font-sans text-[13px] text-ink-soft mt-1">
                {section === 'connectors'
                  ? 'Connect the sources Thoughtbed reads from. Your bed is yours.'
                  : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close settings"
              className="w-8 h-8 rounded-soft flex items-center justify-center text-tag hover:text-ink hover:bg-paper-2 transition-colors"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-8 py-6">
            {section === 'connectors' && <ConnectorsPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
