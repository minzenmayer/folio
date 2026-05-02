// Folio · Public landing page
// The "studio is opening soon" face. Editorial preview of the product
// for someone arriving before they sign in.
// Once authed, redirects sent to /studio (the Writer surface, in time).

import Link from 'next/link';
import { SignedIn, SignedOut } from '@clerk/nextjs';
import { Masthead } from '@/components/Masthead';
import { Footer } from '@/components/Footer';
import { WaitlistForm } from '@/components/WaitlistForm';
import { LifecycleLoop } from '@/components/LifecycleLoop';

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      <Masthead
        rightSlot={
          <div className="flex items-center gap-5">
            <SignedIn>
              <Link
                href="/studio"
                className="text-ink-soft hover:text-accent transition-colors"
              >
                Open studio →
              </Link>
            </SignedIn>
            <SignedOut>
              <Link
                href="/sign-in"
                className="text-ink-soft hover:text-accent transition-colors"
              >
                Sign in
              </Link>
            </SignedOut>
            <span className="text-tag/60 hidden sm:inline">·</span>
            <span className="text-tag hidden sm:inline">opening soon</span>
          </div>
        }
      />

      {/* HERO */}
      <section className="border-b border-rule">
        <div className="max-w-[1200px] mx-auto px-[7%] py-24 md:py-36">
          <div className="max-w-[760px] mx-auto text-center">
            <div className="font-sans text-[12px] tracking-[0.32em] uppercase text-accent font-bold mb-9">
              A studio for your own thinking
            </div>
            <h1 className="font-serif font-normal text-[clamp(48px,8vw,108px)] leading-[0.95] tracking-tightest text-ink mb-6">
              From you,
              <br />
              <em className="italic font-light text-accent">not for you.</em>
            </h1>
            <p className="font-serif font-light text-[clamp(20px,2.2vw,26px)] leading-[1.45] text-ink-soft max-w-[56ch] mx-auto mb-12">
              Folio is your idea bank, your maturation surface, and your writing
              partner — a place where your thinking is captured, evolved, and
              turned into writing.{' '}
              <span className="text-accent">
                The studio's not open yet. Leave your address and we'll write
                when it is.
              </span>
            </p>

            <WaitlistForm variant="hero" />
          </div>
        </div>
      </section>

      {/* MANIFESTO */}
      <section className="border-b border-rule">
        <div className="max-w-[1200px] mx-auto px-[7%] py-24">
          <div className="max-w-[760px] mx-auto">
            <div className="font-mono text-[12px] tracking-[0.12em] text-accent mb-5">
              01 / The line
            </div>
            <h2 className="font-serif font-medium text-[clamp(32px,4vw,48px)] leading-[1.05] tracking-tighter text-ink mb-10 max-w-[20ch]">
              Other tools write{' '}
              <em className="italic font-normal text-accent">for</em> you.
              <br />
              Folio writes{' '}
              <em className="italic font-normal text-accent">from</em> you.
            </h2>
            <p className="font-serif text-[19px] leading-[1.65] text-ink-soft mb-6">
              Most "second brain" tools are passive. They store; they do not
              produce. Most AI writing tools are productive. They generate; they
              do not think with you. Folio sits in the seam — the place where
              thinking matures into writing, slowly, with care, in a way you can
              feel yourself change.
            </p>
            <p className="font-serif text-[19px] leading-[1.65] text-ink-soft">
              When you draft inside Folio, the assistant in the right rail pulls
              from{' '}
              <em className="italic text-ink">
                your captures, your matured threads, your past artifacts, your
                marginalia
              </em>{' '}
              — never from a generic playbook, never from the public web. The
              bank gets denser the more you live in it. The system becomes more{' '}
              <em className="italic text-ink">you</em> over time.
            </p>
          </div>
        </div>
      </section>

      {/* THREE ROOMS */}
      <section className="border-b border-rule">
        <div className="max-w-[1200px] mx-auto px-[7%] py-24">
          <div className="max-w-[760px] mx-auto mb-12">
            <div className="font-mono text-[12px] tracking-[0.12em] text-accent mb-5">
              02 / The product
            </div>
            <h2 className="font-serif font-medium text-[clamp(32px,4vw,48px)] leading-[1.05] tracking-tighter text-ink mb-6 max-w-[22ch]">
              A page to write on. A library to wander.{' '}
              <em className="italic font-normal text-accent">
                An assistant beside you.
              </em>
            </h2>
            <p className="font-serif text-[20px] leading-[1.45] text-ink-soft max-w-[56ch] font-light">
              Three rooms. The same bank underneath. Different jobs at the
              front.
            </p>
          </div>

          <div className="max-w-[1080px] mx-auto grid md:grid-cols-3 border border-rule bg-rule">
            <div className="bg-paper p-10">
              <div className="font-mono text-[11px] tracking-[0.18em] text-accent font-bold mb-4">
                SURFACE / 01
              </div>
              <h3 className="font-serif font-normal text-[32px] tracking-editorial text-ink mb-2">
                The Page
              </h3>
              <div className="font-serif italic text-[15px] text-accent mb-4">
                where you write
              </div>
              <p className="font-sans text-[15px] leading-[1.6] text-ink-soft">
                The Writer-first home. You arrive, the cursor is essentially
                blinking. A short list of drafts to continue beneath; The
                Library suggesting alongside. Most days, the user has something
                to say — Folio honours that as the default.
              </p>
            </div>

            <div className="bg-paper p-10">
              <div className="font-mono text-[11px] tracking-[0.18em] text-accent font-bold mb-4">
                SURFACE / 02
              </div>
              <h3 className="font-serif font-normal text-[32px] tracking-editorial text-ink mb-2">
                The Library
              </h3>
              <div className="font-serif italic text-[15px] text-accent mb-4">
                where ideas live
              </div>
              <p className="font-sans text-[15px] leading-[1.6] text-ink-soft">
                The wandering surface. Every idea, in any state — seed, forming,
                shaping, ready, circulated. Captures, threads, syntheses,
                marginalia, past artifacts. Browse by maturity, theme, graph, or
                day.
              </p>
            </div>

            <div className="bg-paper p-10">
              <div className="font-mono text-[11px] tracking-[0.18em] text-accent font-bold mb-4">
                SURFACE / 03
              </div>
              <h3 className="font-serif font-normal text-[32px] tracking-editorial text-ink mb-2">
                The Assistant
              </h3>
              <div className="font-serif italic text-[15px] text-accent mb-4">
                who reads as you write
              </div>
              <p className="font-sans text-[15px] leading-[1.6] text-ink-soft">
                The AI in the right rail when you draft. Sources from your bank.
                Suggests angles from adjacent ideas. Surfaces tensions you've
                already held. Holds your voice. Spars when you're stuck.{' '}
                <em className="italic text-ink">Never writes for you.</em>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* LIFECYCLE */}
      <section className="border-b border-rule">
        <div className="max-w-[1200px] mx-auto px-[7%] py-24">
          <div className="max-w-[760px] mx-auto mb-10">
            <div className="font-mono text-[12px] tracking-[0.12em] text-accent mb-5">
              03 / The thesis
            </div>
            <h2 className="font-serif font-medium text-[clamp(32px,4vw,48px)] leading-[1.05] tracking-tighter text-ink mb-6 max-w-[22ch]">
              An idea has a lifecycle.{' '}
              <em className="italic font-normal text-accent">
                So should the tool that holds it.
              </em>
            </h2>
            <p className="font-serif text-[20px] leading-[1.45] text-ink-soft max-w-[56ch] font-light">
              A closed loop with four stages. What you write becomes substrate
              for what you write next. The bank is alive.
            </p>
          </div>

          <div className="max-w-[900px] mx-auto bg-paper border border-rule px-8 md:px-14 py-14 text-center">
            <div className="font-sans text-[11px] tracking-[0.22em] uppercase text-accent font-bold mb-7">
              ▸ The closed loop
            </div>
            <LifecycleLoop />
          </div>
        </div>
      </section>

      {/* CLOSING WAITLIST */}
      <section>
        <div className="max-w-[1200px] mx-auto px-[7%] py-32 text-center">
          <div className="font-mono text-[12px] tracking-[0.22em] uppercase text-accent font-bold mb-8">
            ▸ When the studio opens
          </div>
          <h2 className="font-serif font-normal text-[clamp(36px,5vw,64px)] leading-[1.05] tracking-tightest text-ink mb-6 max-w-[22ch] mx-auto">
            We'll write{' '}
            <em className="italic font-light text-accent">when it's open.</em>
          </h2>
          <p className="font-serif font-light text-[19px] leading-[1.55] text-ink-soft max-w-[50ch] mx-auto mb-10">
            One email. Probably in a few weeks. Nothing in between.
          </p>
          <WaitlistForm variant="closing" />
        </div>
      </section>

      <Footer />
    </div>
  );
}
