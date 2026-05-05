// Thoughtbed · /studio/voice — Phase 15a (2026-05-05)
//
// Single page; two platforms (longform / linkedin) toggled via a
// segmented control. Three sections per platform:
//   1. Voice profile — auto-derived (read-only) + manual additions
//      (editable). Per-platform Rebuild button + last-built timestamp.
//   2. Canonical pieces — list of source pieces with star toggles.
//      Search box.
//   3. Empty / cold-start state when no profile + thin corpus.
//
// See spec: ~/Desktop/Thoughtbed/phase15a_voice_id_spec.md

import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db, voiceProfiles } from '@/db';
import { requireUser } from '@/lib/auth';
import { listCanonicalCandidates } from './actions';
import { VoiceClient } from './VoiceClient';

export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');
  const user = await requireUser();

  const [profileRows, longformList, linkedinList] = await Promise.all([
    db
      .select()
      .from(voiceProfiles)
      .where(eq(voiceProfiles.userId, user.id)),
    listCanonicalCandidates({ platform: 'longform', limit: 200 }),
    listCanonicalCandidates({ platform: 'linkedin', limit: 200 }),
  ]);

  const longformRow = profileRows.find((r) => r.platform === 'longform');
  const linkedinRow = profileRows.find((r) => r.platform === 'linkedin');

  return (
    <section>
      <div className="max-w-[920px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-8">
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink mb-2">
            Voice
          </h1>
          <p className="font-sans text-[15.5px] leading-[1.55] text-ink-soft max-w-[58ch]">
            How you write — built from your own corpus. The composer reads
            this when it needs to imitate your voice. Two profiles, one
            per platform.
          </p>
        </div>

        <VoiceClient
          longformProfile={
            longformRow
              ? {
                  summary: longformRow.summary,
                  attributesAuto: castStringArray(longformRow.attributesAuto),
                  thingsToAvoidAuto: castStringArray(
                    longformRow.thingsToAvoidAuto
                  ),
                  attributesManual: castStringArray(
                    longformRow.attributesManual
                  ),
                  thingsToAvoidManual: castStringArray(
                    longformRow.thingsToAvoidManual
                  ),
                  builtAt: longformRow.builtAt
                    ? longformRow.builtAt.toISOString()
                    : null,
                }
              : null
          }
          linkedinProfile={
            linkedinRow
              ? {
                  summary: linkedinRow.summary,
                  attributesAuto: castStringArray(linkedinRow.attributesAuto),
                  thingsToAvoidAuto: castStringArray(
                    linkedinRow.thingsToAvoidAuto
                  ),
                  attributesManual: castStringArray(
                    linkedinRow.attributesManual
                  ),
                  thingsToAvoidManual: castStringArray(
                    linkedinRow.thingsToAvoidManual
                  ),
                  builtAt: linkedinRow.builtAt
                    ? linkedinRow.builtAt.toISOString()
                    : null,
                }
              : null
          }
          longformCanonical={serializeCandidates(longformList.candidates)}
          linkedinCanonical={serializeCandidates(linkedinList.candidates)}
          longformTallies={{
            totalEligible: longformList.totalEligible,
            totalCanonical: longformList.totalCanonical,
          }}
          linkedinTallies={{
            totalEligible: linkedinList.totalEligible,
            totalCanonical: linkedinList.totalCanonical,
          }}
        />
      </div>
    </section>
  );
}

function castStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function serializeCandidates(
  cs: Awaited<
    ReturnType<typeof listCanonicalCandidates>
  >['candidates']
) {
  return cs.map((c) => ({
    sourceKind: c.sourceKind,
    id: c.id,
    title: c.title,
    snippet: c.snippet,
    postedAt: c.postedAt ? c.postedAt.toISOString() : null,
    isCanonical: c.isCanonical,
  }));
}
