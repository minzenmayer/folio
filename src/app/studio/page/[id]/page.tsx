// Thoughtbed · /studio/page/[id] — editor for a single draft
//
// Loads the draft server-side and hands its data to <EditorPane>, the
// client wrapper that owns the live Tiptap editor instance and
// orchestrates DraftMeta + DraftEditor + HistoryModal.
//
// The right pane is <AssistantRailLive> (renamed in copy to "the garden"
// in Sprint 10) — calls findSimilar against the draft's text and lets
// the user pull retrieval results into the editor, plus Reflect.
// EditorPane and AssistantRailLive share the editor instance via
// <EditorContextProvider>; both must be inside the provider.
//
// Sprint 11 dropped the in-page DraftsRail. The global Thoughtbed
// sidebar (rendered by /studio/layout.tsx) already covers draft
// navigation in its Recent section. Layout here is now 2 columns:
// editor | garden rail.
//
// Sprint 12: composer mode threads through via ?mode=newsletter |
// linkedin | self-pilot. The garden rail uses it to pick a voice for
// Reflect; self-pilot also boots the rail dormant.

import type { Metadata } from 'next';
import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { db, drafts } from '@/db';
import { requireUser } from '@/lib/auth';
import {
  AssistantRailLive,
  type GardenRailMode,
} from '../AssistantRailLive';
import { EditorContextProvider } from '../EditorContext';
import { PlanRibbon } from '../PlanRibbon';
import { EditorPane } from './EditorPane';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ mode?: string | string[] }>;

// Static metadata. Per-draft titles surfaced via the in-page <DraftMeta>
// header; we deliberately skip auth-in-metadata to avoid the Clerk 6 +
// Next 15.5 edge case where `auth()` outside the page render path can
// throw.
export const metadata: Metadata = {
  title: 'The Page · Thoughtbed',
};

const VALID_MODES: ReadonlyArray<GardenRailMode> = [
  'newsletter',
  'linkedin',
  'self-pilot',
];

function parseMode(raw: string | string[] | undefined): GardenRailMode | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  return (VALID_MODES as readonly string[]).includes(value)
    ? (value as GardenRailMode)
    : undefined;
}

export default async function DraftEditorPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  // Auth check first — synchronous redirect before any heavy await,
  // per the gotchas doc.
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  const { id } = await params;
  const { mode: modeParam } = await searchParams;
  const mode = parseMode(modeParam);
  const user = await requireUser();

  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
    .limit(1);

  if (!draft) notFound();

  return (
    <EditorContextProvider>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px] min-h-[calc(100vh-0px)]">
        <section className="px-[7%] py-12 md:py-14 overflow-y-auto">
          <div className="max-w-[68ch] mx-auto">
            <EditorPane
              draftId={draft.id}
              initialContent={draft.contentJson}
              initialVersion={draft.version}
              initialUpdatedAt={draft.updatedAt.toISOString()}
              title={draft.title}
              updatedAt={draft.updatedAt}
            />
          </div>
        </section>

        <div className="flex flex-col">
          <PlanRibbon />
          <AssistantRailLive draftId={draft.id} mode={mode} />
        </div>
      </div>
    </EditorContextProvider>
  );
}
