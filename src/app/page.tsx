// Thoughtbed · Public landing
// The "garden is opening soon" face. Editorial preview of the product
// for someone arriving before they sign in.
// Once authed, redirects sent to /studio (the writing surface).

import Link from 'next/link';
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
            <Link
              href="/sign-in"
              className="text-ink-soft hover:text-accent transition-colors"
            >
              Sign in
            </Link>
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
              An idea maturation system
            </div>
            <h1 className="font-serif font-normal text-[clamp(48px,8vw,108px)] leading-[0.95] tracking-tightest text-ink mb-6">
              Mature
              <br />
              <em className="italic font-light text-accent">your mind.</em>
            </h1>
            <p className="font-serif font-light text-[clamp(20px,2.2vw,26px)] leading-[1.45] text-ink-soft max-w-[56ch] mx-auto mb-12">
              Thoughtbed is the place your scattered thoughts grow up. Plant
              seeds, watch them connect, harvest what's ripe. Then write
              from the ones that survived.{' '}
              <span className="text-accent">
                The garden's not open yet. Leave your address and we'll
                write when it is.
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
              Notes apps{' '}
              <em className="italic font-normal text-accent">remember.</em>
              <br />
              Thoughtbed{' '}
              <em className="italic font-normal text-accent">thinks.</em>
            </h2>
            <p className="font-serif text-[19px] leading-[1.65] text-ink-soft mb-6">
              Most "second brain" tools store. They don't produce. Most AI
              writing tools generate. They don't think with you. Thoughtbed
              sits in the seam. The place where a thought matures into
              writing, slowly, with care, in a way you can feel yourself
              change.
            </p>
            <p className="font-serif text-[19px] leading-[1.65] text-ink-soft">
              When you write inside Thoughtbed, the garden in the right
              margin pulls from{' '}
              <em className="italic text-ink">
                your own captures, your matured ideas, your past drafts.
                Your voice.
              </em>{' '}
              Never from a generic playbook. Never from the public web.
              The bed gets denser the more you live in it. The system
              becomes more <em className="italic text-ink">you</em> over
              time.
            </p>
          </div>
        </div>
      </section>

      {/* THREE STAGES — Plant / Grow / Harvest */}
      <section className="border-b border-rule">
        <div className="max-w-[1200px] mx-auto px-[7%] py-24">
          <div className="max-w-[760px] mx-auto mb-12">
            <div className="font-mono text-[12px] tracking-[0.12em] text-accent mb-5">
              02 / The method
            </div>
            <h2 className="font-serif font-medium text-[clamp(32px,4vw,48px)] leading-[1.05] tracking-tighter text-ink mb-6 max-w-[22ch]">
              Plant. Grow.{' '}
              <em className="italic font-normal text-accent">Harvest.</em>
            </h2>
            <p className="font-serif text-[20px] leading-[1.45] text-ink-soft max-w-[56ch] font-light">
              Three stages. The same bed underneath. Different jobs at the
              front.
            </p>
          </div>

          <div className="max-w-[1080px] mx-auto grid md:grid-cols-3 border border-rule bg-rule">
            <div className="bg-paper p-10">
              <div className="font-mono text-[11px] tracking-[0.18em] text-accent font-bold mb-4">
                STAGE / 01
              </div>
              <h3 className="font-serif font-normal text-[32px] tracking-editorial text-ink mb-2">
                Plant
              </h3>
              <div className="font-serif italic text-[15px] text-accent mb-4">
                what you don't want to lose
              </div>
              <p className="font-sans text-[15px] leading-[1.6] text-ink-soft">
                Paste a thought, drop a quote, save a passage from anywhere
                on the web. Ten seconds. No tagging. No filing. The bed
                receives the seed and gets to work.
              </p>
            </div>

            <div className="bg-paper p-10">
              <div className="font-mono text-[11px] tracking-[0.18em] text-accent font-bold mb-4">
                STAGE / 02
              </div>
              <h3 className="font-serif font-normal text-[32px] tracking-editorial text-ink mb-2">
                Grow
              </h3>
              <div className="font-serif italic text-[15px] text-accent mb-4">
                while you're not looking
              </div>
              <p className="font-sans text-[15px] leading-[1.6] text-ink-soft">
                The system connects your seeds to one another, to ideas you
                already hold, and to drafts you've already written. A thought
                that keeps showing up moves forward. The rest stays quiet.
              </p>
            </div>

            <div className="bg-paper p-10">
              <div className="font-mono text-[11px] tracking-[0.18em] text-accent font-bold mb-4">
                STAGE / 03
              </div>
              <h3 className="font-serif font-normal text-[32px] tracking-editorial text-ink mb-2">
                Harvest
              </h3>
              <div className="font-serif italic text-[15px] text-accent mb-4">
                when you sit down to write
              </div>
              <p className="font-sans text-[15px] leading-[1.6] text-ink-soft">
                When you open the page, the garden's already next to you.
                Your ripe ideas surface as you type, in your own voice, ready
                to pull into the draft.{' '}
                <em className="italic text-ink">No more blank Mondays.</em>
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
              for what you write next. The bed is alive.
            </p>
          </div>

          <div className="max-w-[900px] mx-auto bg-paper border border-rule px-8 md:px-14 py-14 text-center">
            <div className="font-sans text-[11px] tracking-[0.22em] uppercase text-accent font-bold mb-7">
              ☘ The closed loop
            </div>
            <LifecycleLoop />
          </div>
        </div>
      </section>

      {/* CLOSING WAITLIST */}
      <section>
        <div className="max-w-[1200px] mx-auto px-[7%] py-32 text-center">
          <div className="font-mono text-[12px] tracking-[0.22em] uppercase text-accent font-bold mb-8">
            ☘ When the bed opens
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
