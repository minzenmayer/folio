// Phase 14b — expand surface for an UNCLAIMED extracted_idea.
// "Make it mine" textarea is the primary CTA.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TempPill } from '../../pills';
import type { Temperature } from '@/lib/garden/types';
import {
  claimExtractedIdea,
  markHot,
  setAside,
  confirmMerge,
} from '../../actions';

interface Ext {
  id: string;
  title: string;
  claim: string;
  evidence: string | null;
  sourceKind: string;
  sourceTitle: string;
  temperature: Temperature;
}

export function ExpandSurfaceUnclaimed({ ext }: { ext: Ext }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [claimText, setClaimText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [mergeSuggested, setMergeSuggested] = useState<{
    targetIdeaId: string;
    cosine: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleClaim() {
    if (claimText.trim().length === 0) return;
    setBusy('claim');
    setError(null);
    start(async () => {
      const r = await claimExtractedIdea({
        extractedId: ext.id,
        claimText,
      });
      if ('mergeSuggested' in r) {
        setMergeSuggested(r.mergeSuggested);
        setBusy(null);
      } else if ('ideaId' in r) {
        router.push(`/studio/garden/${r.ideaId}`);
      } else if (!r.ok) {
        setError(r.reason);
        setBusy(null);
      }
    });
  }

  function handleMergeChoice(mode: 'merge_body' | 'link_extends' | 'replace_essence') {
    if (!mergeSuggested) return;
    setBusy(`merge-${mode}`);
    start(async () => {
      const r = await confirmMerge({
        extractedId: ext.id,
        targetIdeaId: mergeSuggested.targetIdeaId,
        mode,
        claimText,
      });
      if (r.ok) {
        router.push(`/studio/garden/${mergeSuggested.targetIdeaId}`);
      } else {
        setError(r.reason);
        setBusy(null);
      }
    });
  }

  function action(name: 'hot' | 'set') {
    setBusy(name);
    start(async () => {
      if (name === 'hot') await markHot('extracted_idea', ext.id);
      if (name === 'set') await setAside('extracted_idea', ext.id);
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

        <h1 className="font-serif text-[26px] font-medium leading-[1.25] tracking-tight text-ink mb-3">
          {ext.title}
        </h1>

        <div className="flex gap-3 flex-wrap items-center mb-6 pb-4 border-b border-rule">
          <TempPill t={ext.temperature} />
          <span className="font-mono text-[10px] tracking-[0.06em] text-tag">●○○○ seed</span>
          <span className="ml-auto font-mono text-[10px] tracking-[0.12em] uppercase text-tag/70">unclaimed</span>
        </div>

        {/* Make it mine OR merge picker */}
        {!mergeSuggested ? (
          <div className="rounded-md p-4 mb-6 border border-[#EF9F27] bg-[#FAEEDA]">
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#633806] font-medium mb-1">
              Make it mine
            </div>
            <p className="font-sans text-[13px] text-[#633806] leading-[1.55] mb-3">
              Add a sentence in your own words. That turns this from an extracted claim into one of your ideas. It gets a body, a temperature bump, and a spot in the digest.
            </p>
            <textarea
              value={claimText}
              onChange={(e) => setClaimText(e.target.value)}
              placeholder="Why this matters to you · what you'd do with it · the angle you'd take..."
              className="w-full min-h-[80px] font-sans text-[13px] p-3 rounded-md border border-[#D89F4A] bg-paper focus:outline-none focus:border-[#854F0B]"
            />
            <div className="flex gap-2 items-center mt-2 flex-wrap">
              <button
                onClick={handleClaim}
                disabled={pending || claimText.trim().length === 0}
                className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-ink text-paper border border-ink disabled:opacity-50"
              >
                {busy === 'claim' ? 'Claiming…' : 'Claim it'}
              </button>
              <span className="font-sans text-[12px] text-[#633806]">
                → becomes warm + shaping, lands in your digest tomorrow
              </span>
            </div>
            {error && (
              <p className="font-mono text-[11px] text-[#A32D2D] mt-2">{error}</p>
            )}
          </div>
        ) : (
          <div className="rounded-md p-4 mb-6 border border-[#0F6E56] bg-[#E1F5EE]">
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#04342C] font-medium mb-1">
              Looks like an idea you've already claimed
            </div>
            <p className="font-sans text-[13px] text-[#04342C] leading-[1.55] mb-3">
              This claim overlaps {Math.round(mergeSuggested.cosine * 100)}% with one of your existing ideas. How do you want to handle it?
            </p>
            <div className="grid gap-2">
              <button
                onClick={() => handleMergeChoice('merge_body')}
                disabled={pending}
                className="text-left font-sans text-[13px] px-3 py-2 rounded-md bg-paper text-ink border border-rule hover:border-rule-strong disabled:opacity-50"
              >
                <strong>Merge claim into body</strong> · append the new claim as a paragraph (with attribution)
              </button>
              <button
                onClick={() => handleMergeChoice('link_extends')}
                disabled={pending}
                className="text-left font-sans text-[13px] px-3 py-2 rounded-md bg-paper text-ink border border-rule hover:border-rule-strong disabled:opacity-50"
              >
                <strong>Keep separate, link as 'extends'</strong> · creates a new idea linked to the existing one
              </button>
              <button
                onClick={() => handleMergeChoice('replace_essence')}
                disabled={pending}
                className="text-left font-sans text-[13px] px-3 py-2 rounded-md bg-paper text-ink border border-rule hover:border-rule-strong disabled:opacity-50"
              >
                <strong>Replace essence</strong> · this claim becomes the new one-line essence
              </button>
              <button
                onClick={() => setMergeSuggested(null)}
                disabled={pending}
                className="text-left font-sans text-[12px] px-3 py-2 rounded-md text-[#04342C] hover:underline disabled:opacity-50"
              >
                ← Back, claim as new
              </button>
            </div>
          </div>
        )}

        {/* Source claim */}
        <div className="mb-7">
          <h3 className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium mb-2">Source claim</h3>
          <p className="font-serif text-[15px] leading-[1.55] text-ink">
            {ext.claim}
          </p>
        </div>

        {/* Evidence */}
        {ext.evidence && (
          <div className="mb-7">
            <div className="rounded-md bg-paper-2 p-3">
              <div className="font-mono text-[10px] tracking-[0.1em] uppercase text-tag mb-2">
                Evidence from {ext.sourceKind === 'obsidian_note' ? 'vault' : ext.sourceKind === 'newsletter_issue' ? 'your newsletter' : ext.sourceKind === 'linkedin_post' ? 'LinkedIn' : 'Gmail'}
              </div>
              <p className="font-sans text-[12px] italic leading-[1.55] text-ink-soft">
                {ext.evidence}
              </p>
            </div>
          </div>
        )}

        {/* Provenance */}
        <div className="mb-7">
          <h3 className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium mb-2">Provenance</h3>
          <p className="font-sans text-[13px] text-ink-soft">
            Extracted from <span className="text-ink">{ext.sourceTitle}</span>
          </p>
        </div>

        {/* Actions */}
        <div className="pt-4 border-t border-rule flex gap-2 flex-wrap">
          <button
            onClick={() => action('hot')}
            disabled={pending}
            className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-paper text-ink border border-rule hover:border-rule-strong disabled:opacity-50"
          >
            {busy === 'hot' ? 'Marking…' : 'Mark hot'}
          </button>
          <button
            onClick={() => action('set')}
            disabled={pending}
            className="font-sans text-[13px] px-3 py-[6px] rounded-md bg-paper text-ink border border-rule hover:border-rule-strong disabled:opacity-50"
          >
            {busy === 'set' ? 'Setting aside…' : 'Set aside'}
          </button>
        </div>
      </div>
    </section>
  );
}
