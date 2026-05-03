// Thoughtbed · Settings · Connectors
//
// Sprint 12 shipped this as static scaffolding. Sprint 13 Wave 1 makes the
// Beehiiv card LIVE — connect via API key, immediate sync, last-synced
// status, disconnect — while leaving the other four (Obsidian, LinkedIn,
// Google Drive, Gmail) as `soon` placeholders waiting for their sprint.
//
// The page itself stays a server component: it loads the live Beehiiv
// status from the DB and hands it to the client BeehiivCard. Other cards
// stay declarative since they have no state to read.

import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { BeehiivCard } from './BeehiivCard';
import { getBeehiivStatus } from './actions';

type ConnectorCard = {
  id: string;
  name: string;
  glyph: string;
  blurb: string;
};

// Order matches the Sprint 13–16 ship order. The user reads this top-down
// and can map each card to a future release.
const SOON_CONNECTORS: ConnectorCard[] = [
  {
    id: 'obsidian',
    name: 'Obsidian',
    glyph: '◇',
    blurb:
      'Syncs your Markdown vault. Each note becomes a capture the bed can connect, surface, and reflect against.',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    glyph: 'in',
    blurb:
      'Your posts and comments. Voice and style training, kept private to your own bed.',
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    glyph: '▭',
    blurb:
      'Selected docs land as captures. Pick which folders the bed reads — nothing automatic.',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    glyph: '@',
    blurb:
      'Subscribed newsletters land in the Inbox; you triage. Other email stays untouched.',
  },
];

export default async function ConnectorsPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  const beehiivStatus = await getBeehiivStatus();

  return (
    <section>
      <div className="max-w-[860px] mx-auto px-[7%] py-12 md:py-16">
        <div className="mb-10">
          <div className="font-mono text-[12px] tracking-[0.22em] uppercase text-accent font-bold mb-4">
            ⚙ Settings · Connectors
          </div>
          <h1 className="font-serif font-normal text-[clamp(36px,5vw,56px)] leading-[1.05] tracking-tightest text-ink mb-3">
            What feeds{' '}
            <em className="italic font-light text-accent">your bed.</em>
          </h1>
          <p className="font-serif font-light text-[18px] leading-[1.5] text-ink-soft max-w-[60ch]">
            The Inbox is the primary loop — anything you paste lands there.
            Connectors flow in automatically: your archive, your reading,
            your work. Beehiiv is live; the rest are coming up next.
          </p>
        </div>

        <ul className="grid sm:grid-cols-2 gap-4 mb-10">
          <BeehiivCard initialStatus={beehiivStatus} />

          {SOON_CONNECTORS.map((c) => (
            <li
              key={c.id}
              className="rounded-panel bg-paper border border-rule p-6 flex flex-col gap-3 transition-shadow hover:shadow-soft"
            >
              <div className="flex items-center gap-3">
                <span
                  className="w-10 h-10 rounded-soft bg-paper-2 flex items-center justify-center font-mono text-[16px] text-accent font-bold"
                  aria-hidden
                >
                  {c.glyph}
                </span>
                <h2 className="font-serif text-[20px] text-ink leading-[1.2] flex-1">
                  {c.name}
                </h2>
                <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 rounded-full px-2.5 py-1">
                  soon
                </span>
              </div>
              <p className="font-serif text-[14px] leading-[1.55] text-ink-soft">
                {c.blurb}
              </p>
              <div className="mt-auto pt-2">
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  className="font-sans text-[12px] font-medium rounded-soft px-4 py-2 bg-paper-2 text-tag/80 cursor-not-allowed border border-rule"
                  title="Coming in a later sprint"
                >
                  Connect
                </button>
              </div>
            </li>
          ))}
        </ul>

        <div className="rounded-card bg-paper-2/60 border border-rule px-5 py-5">
          <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-2">
            ▸ Privacy
          </div>
          <p className="font-serif italic text-[15px] leading-[1.6] text-ink-soft">
            Thoughtbed only reads what you connect, never sells, and never
            trains on you. Your bed is yours. API keys are encrypted at rest
            with AES-256-GCM and zeroed on disconnect.
          </p>
        </div>
      </div>
    </section>
  );
}
