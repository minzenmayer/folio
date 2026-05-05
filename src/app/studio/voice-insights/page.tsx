// Thoughtbed · /studio/voice-insights — Phase 15a (2026-05-05)
//
// User-facing snapshot of how you write. Reads the voice_profiles row
// the training surface (Settings → Voice ID) builds, and renders it as
// editorial copy: archetype hint, summary, characteristic moves, taboos.
//
// Differs from /studio/voice (the training page):
//   · Voice ID = configuration. Canonical pieces, rebuild button,
//     manual additions. Lives in Settings.
//   · Voice insights = snapshot. Read-only. Different vibe — feels
//     like a Grammarly / Wispr-style snapshot rather than a config
//     page.
//
// MVP shape: shows what's in voice_profiles. Future: derived "common
// phrases" from recent corpus, archetype classification, shareable
// card.

import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { db, voiceProfiles } from '@/db';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

type SerializedProfile = {
  platform: 'longform' | 'linkedin';
  summary: string | null;
  attributes: string[];
  thingsToAvoid: string[];
  builtAt: string | null;
};

function castStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default async function VoiceInsightsPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');
  const user = await requireUser();

  const rows = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, user.id));

  const profiles: SerializedProfile[] = rows.map((r) => ({
    platform: r.platform as 'longform' | 'linkedin',
    summary: r.summary,
    attributes: [
      ...castStringArray(r.attributesAuto),
      ...castStringArray(r.attributesManual),
    ],
    thingsToAvoid: [
      ...castStringArray(r.thingsToAvoidAuto),
      ...castStringArray(r.thingsToAvoidManual),
    ],
    builtAt: r.builtAt ? r.builtAt.toISOString() : null,
  }));

  const longform = profiles.find((p) => p.platform === 'longform');
  const linkedin = profiles.find((p) => p.platform === 'linkedin');
  const hasAny =
    (longform &&
      (longform.summary ||
        longform.attributes.length > 0 ||
        longform.thingsToAvoid.length > 0)) ||
    (linkedin &&
      (linkedin.summary ||
        linkedin.attributes.length > 0 ||
        linkedin.thingsToAvoid.length > 0));

  return (
    <section>
      <div className="max-w-[820px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-10">
          <p className="font-mono text-[11px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
            Voice insights
          </p>
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink mb-3">
            How you write.
          </h1>
          <p className="font-sans text-[15.5px] leading-[1.6] text-ink-soft max-w-[58ch]">
            A snapshot of your voice. Pulled from pieces you&apos;ve
            written and canonical samples you&apos;ve flagged. The
            composer reads this when it imitates your voice.
          </p>
        </div>

        {!hasAny ? (
          <EmptyState />
        ) : (
          <>
            {longform && hasContent(longform) && (
              <ProfileCard
                eyebrow="Longform"
                hint="newsletters · vault notes"
                profile={longform}
              />
            )}

            {linkedin && hasContent(linkedin) && (
              <div className="mt-10">
                <ProfileCard
                  eyebrow="Short form"
                  hint="social posts"
                  profile={linkedin}
                />
              </div>
            )}

            {/* Train CTA */}
            <div className="mt-12 border-t border-rule pt-8">
              <p className="font-sans text-[13px] text-ink-soft leading-[1.55] mb-4 max-w-[60ch]">
                Voice ID lives in Settings. Flag the pieces that sound most
                like you, add the things Claude missed, rebuild whenever
                your voice changes.
              </p>
              <Link
                href="/studio?settings=voice"
                className="inline-block font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 border border-rule text-ink hover:bg-paper-2 transition-colors"
              >
                Open Voice ID →
              </Link>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function hasContent(p: SerializedProfile): boolean {
  return Boolean(
    p.summary || p.attributes.length > 0 || p.thingsToAvoid.length > 0
  );
}

function ProfileCard({
  eyebrow,
  hint,
  profile,
}: {
  eyebrow: string;
  hint: string;
  profile: SerializedProfile;
}) {
  return (
    <article className="bg-paper rounded-card border border-rule overflow-hidden">
      <header className="px-6 py-5 border-b border-rule flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-1">
            {hint}
          </p>
          <h2 className="font-sans text-[24px] font-semibold tracking-tight text-ink">
            {eyebrow}
          </h2>
        </div>
        <p className="font-mono text-[10px] tracking-[0.04em] text-tag whitespace-nowrap">
          Built {timeAgo(profile.builtAt)}
        </p>
      </header>

      {profile.summary && (
        <section className="px-6 py-5 border-b border-rule">
          <p className="font-serif italic text-[16px] leading-[1.6] text-ink">
            {profile.summary}
          </p>
        </section>
      )}

      {profile.attributes.length > 0 && (
        <section className="px-6 py-5 border-b border-rule">
          <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
            Characteristic moves
          </h3>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {profile.attributes.map((a, i) => (
              <li
                key={i}
                className="font-sans text-[14px] leading-[1.5] text-ink"
              >
                · {a}
              </li>
            ))}
          </ul>
        </section>
      )}

      {profile.thingsToAvoid.length > 0 && (
        <section className="px-6 py-5">
          <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
            What you avoid
          </h3>
          <ul className="flex flex-col gap-1.5">
            {profile.thingsToAvoid.map((a, i) => (
              <li
                key={i}
                className="font-sans text-[14px] leading-[1.5] text-ink-soft"
              >
                · {a}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function EmptyState() {
  return (
    <div className="bg-paper rounded-card border border-rule px-6 py-10 text-center">
      <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
        Nothing yet
      </p>
      <h2 className="font-sans text-[20px] font-semibold tracking-tight text-ink mb-3">
        Your voice insights will land here.
      </h2>
      <p className="font-sans text-[14.5px] leading-[1.6] text-ink-soft max-w-[52ch] mx-auto mb-6">
        Train a voice profile first. This page will show what Thoughtbed
        sees in your writing. Characteristic moves, taboos, the shape of
        how you write longform versus short form. Takes about 30 seconds.
      </p>
      <Link
        href="/studio?settings=voice"
        className="inline-block font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-5 py-2.5 bg-ink text-bg hover:bg-ink-soft transition-colors"
      >
        Train your voice →
      </Link>
    </div>
  );
}
