// Thoughtbed · EdgePromptZone — Phase 17 (2026-05-05)
//
// Top-of-Garden zone showing up to 3 ideas "on the edge" with one-tap
// actions. Quiet states:
//   · 0 matches → component renders nothing (parent passes no zone)
//   · 1-2 matches → collapsed line with chevron expand
//   · 3+ matches → fully open by default
// Daily auto-collapse on dismiss, tracked in localStorage.

'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { EdgePrompt } from '@/lib/garden/edge-prompts';
import { setTemperature, setAside } from './actions';
import { pushToReadyAction } from './edge-actions';

const STORAGE_KEY = 'tb_edge_collapsed_today';

function collapsedToday(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    const today = new Date().toISOString().slice(0, 10);
    return stored === today;
  } catch {
    return false;
  }
}

function markCollapsedToday() {
  if (typeof window === 'undefined') return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    window.localStorage.setItem(STORAGE_KEY, today);
  } catch {
    // ignore
  }
}

export function EdgePromptZone({ prompts }: { prompts: EdgePrompt[] }) {
  const [open, setOpen] = useState(prompts.length >= 3);
  const [collapsedDismissed, setCollapsedDismissed] = useState(false);

  useEffect(() => {
    setCollapsedDismissed(collapsedToday());
  }, []);

  if (prompts.length === 0) return null;

  // Sub-3 matches default to a one-line collapsed state until clicked.
  if (!open && prompts.length < 3) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-6 w-full text-left rounded-card border border-rule bg-paper-2 px-5 py-3 hover:bg-paper transition-colors flex items-baseline justify-between gap-3"
      >
        <span className="font-sans text-[14px] text-ink">
          {prompts.length} idea{prompts.length === 1 ? '' : 's'} on the edge
        </span>
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag">
          Open ↓
        </span>
      </button>
    );
  }

  // Fully dismissed for the day.
  if (collapsedDismissed) return null;

  return (
    <section className="mb-6 rounded-card border border-rule bg-paper-2 px-5 py-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
          On the edge
        </h3>
        <button
          type="button"
          onClick={() => {
            markCollapsedToday();
            setCollapsedDismissed(true);
          }}
          className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag hover:text-ink transition-colors"
        >
          Hide for today
        </button>
      </div>
      <ul className="flex flex-col gap-2">
        {prompts.map((p) => (
          <li key={p.ideaId}>
            <PromptRow prompt={p} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PromptRow({ prompt }: { prompt: EdgePrompt }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  const primaryLabel =
    prompt.primaryAction === 'warm'
      ? 'Warm it'
      : prompt.primaryAction === 'push_to_ready'
        ? 'Push to ready'
        : 'Open in editor';

  function runPrimary() {
    if (pending) return;
    setBusy('primary');
    start(async () => {
      try {
        if (prompt.primaryAction === 'warm') {
          await setTemperature('idea', prompt.ideaId, 'warm');
        } else if (prompt.primaryAction === 'push_to_ready') {
          await pushToReadyAction({ ideaId: prompt.ideaId });
        } else {
          // open_editor → navigate to garden expand surface; the
          // 'Open in editor' button on the claimed surface continues
          // the flow.
          router.push(`/studio/garden/${prompt.ideaId}`);
        }
      } catch (err) {
        console.warn('[EdgePromptZone] primary failed', err);
      } finally {
        setBusy(null);
      }
    });
  }

  function runSetAside() {
    if (pending) return;
    setBusy('aside');
    start(async () => {
      try {
        await setAside('idea', prompt.ideaId);
      } catch (err) {
        console.warn('[EdgePromptZone] set aside failed', err);
      } finally {
        setBusy(null);
      }
    });
  }

  return (
    <div className="rounded-soft border border-rule bg-paper px-4 py-3 flex items-baseline gap-3">
      <div className="flex-1 min-w-0">
        <p className="font-sans text-[14px] font-medium text-ink leading-[1.4] mb-0.5">
          {prompt.title}
        </p>
        <p className="font-sans text-[12.5px] italic text-ink-soft leading-[1.4]">
          {prompt.reasonLine}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={runPrimary}
          disabled={pending}
          className="font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-3 py-1.5 bg-ink text-bg hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy === 'primary' ? 'Working…' : primaryLabel}
        </button>
        <button
          type="button"
          onClick={runSetAside}
          disabled={pending}
          className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink disabled:opacity-50 transition-colors"
        >
          {busy === 'aside' ? 'Setting…' : 'Set aside'}
        </button>
      </div>
    </div>
  );
}
