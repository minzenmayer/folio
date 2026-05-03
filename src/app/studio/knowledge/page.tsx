// Thoughtbed · Knowledge
// Where the user wires up the inputs that make the bed know who they are:
// LinkedIn, newsletter archive, RSS feeds, URLs, file uploads. Combined with
// VoiceID they form the user's content-and-voice profile, which the garden
// rail and Reflect both draw on for tone alignment.
//
// Sprint 10 ships this as a deliberate placeholder — the Inbox + Garden are
// already the primary input loops. Sprint 11+ will bring up the actual
// connectors (OAuth into LinkedIn, RSS pull, etc.) with the same care the
// rest of the studio takes around privacy and voice.

import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

const SOURCES = [
  {
    id: 'linkedin',
    label: 'LinkedIn',
    blurb:
      'Posts, comments, and articles you\'ve already published. Voice training data, in your own words.',
    glyph: 'in',
    state: 'soon',
  },
  {
    id: 'newsletter',
    label: 'Newsletter archive',
    blurb:
      'Your existing issues. The bed reads what you\'ve already approved as yours and tunes Reflect to match.',
    glyph: '✉',
    state: 'soon',
  },
  {
    id: 'rss',
    label: 'RSS / external newsletters',
    blurb:
      'Other writers you read. Captures land as seeds, attributed to source. Voice stays separate from yours.',
    glyph: '⎁',
    state: 'soon',
  },
  {
    id: 'urls',
    label: 'URL fetch',
    blurb:
      'Drop a link, the bed pulls the readable content as a capture. Source URL preserved.',
    glyph: '↗',
    state: 'soon',
  },
  {
    id: 'uploads',
    label: 'File uploads',
    blurb:
      'PDFs, .md, .txt. Anything the bed should read alongside what\'s already there.',
    glyph: '▭',
    state: 'soon',
  },
  {
    id: 'voiceid',
    label: 'VoiceID',
    blurb:
      'Your distinct rhythm, vocabulary, and shape — modeled from what you\'ve already written. The garden writes from this, never around it.',
    glyph: '◉',
    state: 'soon',
  },
];

export default async function KnowledgePage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  return (
    <section>
      <div className="max-w-[800px] mx-auto px-[7%] py-12 md:py-16">
        <div className="mb-10">
          <div className="font-mono text-[12px] tracking-[0.22em] uppercase text-accent font-bold mb-4">
            ▸ Knowledge
          </div>
          <h1 className="font-serif font-normal text-[clamp(36px,5vw,56px)] leading-[1.05] tracking-tightest text-ink mb-3">
            What the bed reads,{' '}
            <em className="italic font-light text-accent">besides you.</em>
          </h1>
          <p className="font-serif font-light text-[18px] leading-[1.5] text-ink-soft max-w-[60ch]">
            The Inbox is the primary loop — anything you paste, plant, or
            highlight lands there. Knowledge is everything else: data sources
            that flow in automatically so the bed knows your voice, your
            archive, and the writers you read.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 mb-12">
          {SOURCES.map((src) => (
            <div
              key={src.id}
              className="border border-rule rounded-[3px] bg-paper/60 px-5 py-5"
            >
              <div className="flex items-baseline gap-2 mb-2">
                <span
                  className="font-mono text-[12px] text-accent font-bold w-7 text-center"
                  aria-hidden
                >
                  {src.glyph}
                </span>
                <h3 className="font-serif text-[18px] text-ink leading-[1.2] flex-1">
                  {src.label}
                </h3>
                <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 border border-rule rounded-full px-2 py-0.5">
                  {src.state}
                </span>
              </div>
              <p className="font-serif text-[14px] leading-[1.55] text-ink-soft pl-9">
                {src.blurb}
              </p>
            </div>
          ))}
        </div>

        <div className="border-t border-rule pt-8">
          <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-3">
            ▸ For now
          </div>
          <p className="font-serif italic text-[16px] text-ink-soft leading-[1.6] max-w-[60ch]">
            Use the{' '}
            <Link
              href="/studio/inbox"
              className="text-accent hover:underline underline-offset-4 not-italic"
            >
              Inbox
            </Link>{' '}
            to plant manually. Anything you paste in becomes a seed the
            garden can connect, surface, and reflect against. The connectors
            above light up as we ship them.
          </p>
        </div>
      </div>
    </section>
  );
}
