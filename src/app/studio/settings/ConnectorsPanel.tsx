// Thoughtbed · ConnectorsPanel
//
// Sprint 14: the connectors content extracted into a panel that the
// SettingsModal renders. Same five-card grid + privacy footer as the
// previous /studio/settings/connectors route page, but designed to fit
// inside an 800px-tall modal without competing with full-width chrome.
//
// Loads BeehiivStatus client-side on mount via the `getBeehiivStatus`
// server action so the modal can be summoned from any /studio/* page
// without forcing the parent layout to know about settings state.

'use client';

import { useEffect, useState } from 'react';
import {
  BeehiivCard,
} from './connectors/BeehiivCard';
import { ObsidianCard } from './connectors/ObsidianCard';
import {
  getBeehiivStatus,
  getObsidianStatus,
  type BeehiivStatus,
  type ObsidianStatus,
} from './connectors/actions';

type ConnectorCard = {
  id: string;
  name: string;
  glyph: string;
  blurb: string;
};

const SOON_CONNECTORS: ConnectorCard[] = [
  {
    id: 'linkedin',
    name: 'LinkedIn',
    glyph: 'in',
    blurb:
      'Your posts and comments. Voice and style training, kept private to your own space.',
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    glyph: 'GD',
    blurb:
      'Selected docs land as captures. Pick which folders Thoughtbed reads — nothing automatic.',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    glyph: '@',
    blurb:
      'Subscribed newsletters land in the Inbox; you triage. Other email stays untouched.',
  },
];

export function ConnectorsPanel() {
  const [status, setStatus] = useState<BeehiivStatus | null>(null);
  const [obsidianStatus, setObsidianStatus] =
    useState<ObsidianStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBeehiivStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : 'Failed to load status');
      });
    getObsidianStatus()
      .then((s) => {
        if (!cancelled) setObsidianStatus(s);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : 'Failed to load status');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <ul className="grid sm:grid-cols-2 gap-3">
        {/* Live Beehiiv card — falls through to a skeleton until status loads */}
        {status ? (
          <BeehiivCard initialStatus={status} />
        ) : (
          <li className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3 min-h-[180px]">
            <div className="flex items-center gap-3">
              <span
                className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[14px] text-tag"
                aria-hidden
              >
                BH
              </span>
              <div className="flex-1">
                <h3 className="font-sans text-[16px] font-semibold text-ink leading-tight">
                  Beehiiv
                </h3>
              </div>
            </div>
            <p className="font-sans text-[13px] text-tag">
              {err ? err : 'Loading…'}
            </p>
          </li>
        )}

        {/* Live Obsidian card — same skeleton pattern */}
        {obsidianStatus ? (
          <ObsidianCard initialStatus={obsidianStatus} />
        ) : (
          <li className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3 min-h-[180px]">
            <div className="flex items-center gap-3">
              <span
                className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[14px] text-tag"
                aria-hidden
              >
                OB
              </span>
              <div className="flex-1">
                <h3 className="font-sans text-[16px] font-semibold text-ink leading-tight">
                  Obsidian
                </h3>
              </div>
            </div>
            <p className="font-sans text-[13px] text-tag">
              {err ? err : 'Loading…'}
            </p>
          </li>
        )}

        {SOON_CONNECTORS.map((c) => (
          <li
            key={c.id}
            className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3"
          >
            <div className="flex items-center gap-3">
              <span
                className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[12px] font-semibold text-tag"
                aria-hidden
              >
                {c.glyph}
              </span>
              <h3 className="font-sans text-[16px] font-semibold text-ink leading-tight flex-1">
                {c.name}
              </h3>
              <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 rounded-full px-2.5 py-1">
                soon
              </span>
            </div>
            <p className="font-sans text-[13px] leading-[1.55] text-ink-soft">
              {c.blurb}
            </p>
            <div className="mt-auto pt-2">
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="font-mono text-[11px] tracking-[0.18em] uppercase rounded-soft px-4 py-2 bg-paper-2 text-tag cursor-not-allowed border border-rule"
                title="Coming in a later sprint"
              >
                Connect
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="rounded-card bg-paper-2/60 border border-rule px-5 py-4">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-1.5">
          Privacy
        </div>
        <p className="font-sans text-[13.5px] leading-[1.55] text-ink-soft">
          Thoughtbed only reads what you connect, never sells, and never
          trains on you. API keys are encrypted at rest with AES-256-GCM
          and zeroed on disconnect.
        </p>
      </div>
    </div>
  );
}
