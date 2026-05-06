// Phase 14b — expand surface for a claimed idea.
// Inline-editable title / essence / body. Quick action chips for temperature.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TempPill, MaturityDots } from '../pills';
import type { Temperature } from '@/lib/garden/types';
import {
  updateIdea,
  markHot,
  coolIt,
  setAside,
  bringBack,
} from '../actions';
import { demoteAutoClaim } from '../seed-actions';
import { markAsWritingMaterial } from '../actions';

interface Idea {
  id: string;
  title: string;
  essence: string | null;
  body: string | null;
  themes: string[];
  maturity: string;
  temperature: Temperature;
  lastVisitedAt: string | null;
  // Phase 17 (2026-05-05): 'authored' | 'claimed' | 'auto_claimed'.
  // Drives the AUTO badge + the Demote affordance below.
  claimKind?: string;
}

export function ExpandSurfaceClaimed({
  idea,
  links,
  provenance,
}: {
  idea: Idea;
  links: Array<{
    kind: string;
    strength: number;
    manual: boolean;
    otherId: string;
    otherTitle: string;
  }>;
  provenance: { kind: string; title: string } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  const [title, setTitle] = useState(idea.title);
  const [essence, setEssence] = useState(idea.essence ?? '');
  const [body, setBody] = useState(idea.body ?? '');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingEssence, setEditingEssence] = useState(false);
  const [editingBody, setEditingBody] = useState(false);

  function saveField(patch: { title?: string; essence?: string; body?: string }) {
    start(async () => {
      await updateIdea({ ideaId: idea.id, ...patch });
      router.refresh();
    });
  }

  function action(name: 'hot' | 'cool' | 'set' | 'back') {
    setBusy(name);
    start(async () => {
      if (name === 'hot') await markHot('idea', idea.id);
      if (name === 'cool') await coolIt('idea', idea.id);
      if (name === 'set') await setAside('idea', idea.id);
      if (name === 'back') await bringBack('idea', idea.id);
      router.refresh();
      setBusy(null);
    });
  }

  return (
    <section>
      <div className="max-w-[760px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-2">
          <Link href="/studio/garden" className="font-mono text-[11px] tracking-[0.06em] text-tag hover:text-ink-soft">
            ← Garden
          </Link>
        </div>

        {/* Title */}
        <div className="mb-3">
          {editingTitle ? (
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                setEditingTitle(false);
                if (title.trim() && title !== idea.title) saveField({ title: title.trim() });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') { setTitle(idea.title); setEditingTitle(false); }
              }}
              className="w-full font-serif text-[28px] font-medium leading-[1.2] tracking-tight text-ink bg-transparent border-b border-rule focus:outline-none focus:border-ink"
            />
          ) : (
            <h1
              onClick={() => setEditingTitle(true)}
              className="font-serif text-[28px] font-medium leading-[1.2] tracking-tight text-ink cursor-text"
            >
              {title}
            </h1>
          )}
        </div>

        {/* Meta */}
        <div className="flex gap-3 flex-wrap items-center mb-6 pb-4 border-b border-rule">
          <TempPill t={idea.temperature} />
          <MaturityDots m={idea.maturity as any} />
          {idea.themes.map((t) => (
            <span key={t} className="font-mono text-[10px] px-2 py-[2px] rounded bg-paper-2 text-tag">
              {t}
            </span>
          ))}
          {idea.claimKind === 'auto_claimed' && (
            <span
              className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag border border-rule rounded px-2 py-[2px]"
              title="Auto-claimed from your own writing. Edit the essence or body below to refine into your own words. Pull this idea into a draft and the badge goes away."
            >
              Auto
            </span>
          )}
          {idea.lastVisitedAt && (
            <span className="ml-auto font-mono text-[10px] tracking-[0.06em] text-tag">
              visited {new Date(idea.lastVisitedAt).toLocaleDateString()}
            </span>
          )}
        </div>

        {/* Essence */}
        <div className="mb-7">
          <h3 className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium mb-2">Essence</h3>
          {editingEssence ? (
            <textarea
              autoFocus
              value={essence}
              onChange={(e) => setEssence(e.target.value)}
              onBlur={() => {
                setEditingEssence(false);
                if (essence !== (idea.essence ?? '')) saveField({ essence });
              }}
              className="w-full font-serif text-[15px] leading-[1.55] text-ink bg-paper rounded-md border border-rule p-3 focus:outline-none focus:border-ink-soft"
              rows={3}
            />
          ) : (
            <p
              onClick={() => setEditingEssence(true)}
              className="font-serif text-[15px] leading-[1.55] text-ink cursor-text"
            >
              {essence || <span className="italic text-tag">Click to add essence. One paragraph that captures the heart of this idea.</span>}
            </p>
          )}
        </div>

        {/* Body */}
        <div className="mb-7">
          <h3 className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium mb-2">Body</h3>
          {editingBody ? (
            <textarea
              autoFocus
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onBlur={() => {
                setEditingBody(false);
                if (body !== (idea.body ?? '')) saveField({ body });
              }}
              className="w-full font-sans text-[14px] leading-[1.65] text-ink bg-paper rounded-md border border-rule p-3 focus:outline-none focus:border-ink-soft"
              rows={10}
            />
          ) : (
            <div
              onClick={() => setEditingBody(true)}
              className="font-sans text-[14px] leading-[1.65] text-ink whitespace-pre-wrap cursor-text"
            >
              {body || <span className="italic text-tag">Click to add a body. Long-form text that grows over time as you merge new claims in.</span>}
            </div>
          )}
        </div>

        {/* Linked ideas */}
        {links.length > 0 && (
          <div className="mb-7">
            <h3 className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium mb-2">
              Linked ideas ({links.length})
            </h3>
            <ul className="space-y-1">
              {links.map((l) => (
                <li key={l.otherId} className="font-sans text-[13px] flex gap-2 items-baseline">
                  <span className="font-mono text-[10px] text-tag w-[80px]">
                    {l.kind === 'extends' && 'extends →'}
                    {l.kind === 'contradicts' && 'contradicts ↔'}
                    {l.kind === 'echoes' && 'echoes ≈'}
                    {l.kind === 'supports' && 'supports ⊕'}
                    {l.kind === 'parent' && 'parent ↑'}
                    {l.kind === 'supersedes' && 'supersedes »'}
                  </span>
                  <Link href={`/studio/garden/${l.otherId}`} className="text-ink hover:underline">
                    {l.otherTitle}
                  </Link>
                  <span className="ml-auto font-mono text-[10px] text-tag/70">
                    {l.manual ? 'manual' : `auto · ${l.strength.toFixed(2)}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Provenance */}
        {provenance && (
          <div className="mb-7">
            <h3 className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium mb-2">Provenance</h3>
            <p className="font-sans text-[13px] text-ink-soft">
              Promoted from{' '}
              <span className="text-ink">
                {provenance.kind === 'newsletter_issue' ? 'your newsletter · ' : ''}
                {provenance.kind === 'obsidian_note' ? 'vault · ' : ''}
                {provenance.kind === 'linkedin_post' ? 'LinkedIn · ' : ''}
                {provenance.kind === 'gmail_message' ? 'Gmail · ' : ''}
                {provenance.title}
              </span>
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="pt-4 border-t border-rule flex gap-2 flex-wrap">
          {idea.temperature === 'set_aside' ? (
            <button
              onClick={() => action('back')}
              disabled={pending}
              className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-ink text-paper border border-ink disabled:opacity-50"
            >
              {busy === 'back' ? 'Bringing back…' : 'Bring back'}
            </button>
          ) : (
            <>
              <button
                onClick={() => action('hot')}
                disabled={pending}
                className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-paper text-ink border border-rule hover:border-rule-strong disabled:opacity-50"
              >
                {busy === 'hot' ? 'Marking…' : 'Mark hot'}
              </button>
              <button
                onClick={() => action('cool')}
                disabled={pending}
                className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-paper text-ink border border-rule hover:border-rule-strong disabled:opacity-50"
              >
                {busy === 'cool' ? 'Cooling…' : 'Cool it'}
              </button>
              <button
                onClick={() => action('set')}
                disabled={pending}
                className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-paper text-ink border border-rule hover:border-rule-strong disabled:opacity-50"
              >
                {busy === 'set' ? 'Setting aside…' : 'Set aside'}
              </button>
              {idea.claimKind === 'auto_claimed' && (
                <>
                  <button
                    onClick={() => {
                      if (pending) return;
                      setBusy('writing');
                      start(async () => {
                        try {
                          await markAsWritingMaterial(idea.id);
                          router.refresh();
                        } catch (err) {
                          console.warn('[ExpandSurfaceClaimed] mark failed', err);
                        } finally {
                          setBusy(null);
                        }
                      });
                    }}
                    disabled={pending}
                    title="Confirms this is real writing material. The idea joins your positive corpus so the system learns to surface similar ideas."
                    className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-ink text-paper border border-ink hover:bg-ink-soft disabled:opacity-50 ml-auto"
                  >
                    {busy === 'writing' ? 'Marking…' : 'This is writing material'}
                  </button>
                  <button
                    onClick={() => {
                      if (pending) return;
                      if (
                        typeof window !== 'undefined' &&
                        !window.confirm(
                          'Demote this idea? It moves back to unclaimed and the partner Garden card disappears.'
                        )
                      ) {
                        return;
                      }
                      setBusy('demote');
                      start(async () => {
                        try {
                          await demoteAutoClaim({ ideaId: idea.id });
                          router.push('/studio/garden');
                        } catch (err) {
                          console.warn('[ExpandSurfaceClaimed] demote failed', err);
                        } finally {
                          setBusy(null);
                        }
                      });
                    }}
                    disabled={pending}
                    title="Reverses the auto-claim. The source extracted idea returns to the unclaimed lane."
                    className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-paper text-tag border border-rule hover:border-rule-strong hover:text-ink disabled:opacity-50"
                  >
                    {busy === 'demote' ? 'Demoting…' : 'Demote'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
