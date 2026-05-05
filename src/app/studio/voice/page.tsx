// Thoughtbed · /studio/voice — Phase 15 (Voice ID UX rework, 2026-05-05)
//
// Server component. Loads the per-platform voice profile rows + the
// training samples already saved for each platform. Hands them to the
// VoiceClient. The training samples shape (5-sample-picker) replaced
// the prior canonical-list shape — pickers and add/remove flows live
// in VoiceClient + voice/actions.ts.

import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db, voiceProfiles } from '@/db';
import { requireUser } from '@/lib/auth';
import { listTrainingSamples } from './actions';
import { VoiceClient } from './VoiceClient';

export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');
  const user = await requireUser();

  const [profileRows, longformSamples, linkedinSamples] = await Promise.all([
    db
      .select()
      .from(voiceProfiles)
      .where(eq(voiceProfiles.userId, user.id)),
    listTrainingSamples({ platform: 'longform' }),
    listTrainingSamples({ platform: 'linkedin' }),
  ]);

  const longformRow = profileRows.find((r) => r.platform === 'longform');
  const linkedinRow = profileRows.find((r) => r.platform === 'linkedin');

  return (
    <section>
      <div className="max-w-[920px] mx-auto px-6 md:px-8 py-12 md:py-16">
        <div className="mb-8">
          <p className="font-mono text-[11px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
            Settings · Voice ID
          </p>
          <h1 className="font-sans text-[clamp(28px,4vw,40px)] font-semibold tracking-tight text-ink mb-2">
            Train your voice.
          </h1>
          <p className="font-sans text-[15.5px] leading-[1.55] text-ink-soft max-w-[58ch]">
            Pick up to five writing samples that sound most like you.
            One Claude pass turns them into a voice profile the
            composer reads. Two profiles, one per platform.
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
          longformSamples={longformSamples.samples}
          linkedinSamples={linkedinSamples.samples}
        />
      </div>
    </section>
  );
}

function castStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
