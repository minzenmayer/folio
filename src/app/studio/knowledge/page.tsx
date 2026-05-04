// Thoughtbed · Knowledge
// Sprint 14 brand pivot: monochrome restyle, drop garden vocabulary.
// Note that real connector setup lives in Settings (the modal); this
// page is a placeholder for now and points to the modal.

import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

const SOURCES = [
  {
    id: 'beehiiv',
    label: 'Beehiiv',
    blurb:
      'Your published newsletter issues. Voice training data in your own approved words.',
    state: 'live',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    blurb:
      'Your published LinkedIn posts. Scraped from your public profile via Apify — no LinkedIn login required.',
    state: 'live',
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    blurb:
      'Sync your Markdown vault from a Git repo. Each note becomes retrievable; ideas extract automatically.',
    state: 'live',
  },
  {
    id: 'gdrive',
    label: 'Google Drive',
    blurb:
      'Selected docs land as captures. Pick which folders Thoughtbed reads — nothing automatic.',
    state: 'soon',
  },
  {
    id: 'gmail',
    label: 'Gmail',
    blurb:
      'Subscribed newsletters detected via OAuth (read-only). You triage which ones land in the corpus from /studio/insights — Reflect surfaces them while you write.',
    state: 'live',
  },
  {
    id: 'voiceid',
    label: 'Voice ID',
    blurb:
      'Your distinct rhythm, vocabulary, and shape — modeled from what you have already written. Reflection writes from this, never around it.',
    state: 'soon',
  },
];

export default async function KnowledgePage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  return (
    <section>
      <div className="max-w-[800px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-8">
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink mb-2">
            Knowledge
          </h1>
          <p className="font-sans text-[15px] leading-[1.55] text-ink-soft max-w-[60ch]">
            The Inbox is the primary loop — anything you paste lands there.
            Knowledge is everything else: data sources that flow in
            automatically so Thoughtbed knows your voice, your archive, and
            the writers you read.
          </p>
        </div>

        <ul className="grid sm:grid-cols-2 gap-3 mb-10">
          {SOURCES.map((src) => (
            <li
              key={src.id}
              className="border border-rule rounded-card bg-paper px-5 py-5"
            >
              <div className="flex items-baseline gap-3 mb-2">
                <h3 className="font-sans text-[16px] font-semibold text-ink leading-[1.3] flex-1">
                  {src.label}
                </h3>
                <span
                  className={`font-mono text-[9px] tracking-[0.22em] uppercase rounded-full px-2 py-0.5 ${
                    src.state === 'live'
                      ? 'bg-ink text-bg'
                      : 'text-tag bg-paper-2 border border-rule'
                  }`}
                >
                  {src.state}
                </span>
              </div>
              <p className="font-sans text-[13.5px] leading-[1.55] text-ink-soft">
                {src.blurb}
              </p>
            </li>
          ))}
        </ul>

        <div className="border-t border-rule pt-6">
          <p className="font-sans text-[14px] text-ink-soft leading-[1.6] max-w-[60ch]">
            Manage connectors in{' '}
            <Link
              href="/studio?settings=connectors"
              scroll={false}
              className="text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink"
            >
              Settings
            </Link>
            . Use the{' '}
            <Link
              href="/studio/inbox"
              className="text-ink underline underline-offset-4 decoration-rule-strong hover:decoration-ink"
            >
              Inbox
            </Link>{' '}
            to capture manually. Anything you paste in becomes a capture
            Thoughtbed can connect, surface, and reflect against.
          </p>
        </div>
      </div>
    </section>
  );
}
