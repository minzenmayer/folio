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
import { type GardenRailMode } from '../AssistantRailLive';
import { ArtifactPanel } from '../ArtifactPanel';
import { ChatCompanion } from '../ChatCompanion';
import { EditorContextProvider } from '../EditorContext';
import { EditorShell } from '../EditorShell';
import { EditorToolbar } from '../EditorToolbar';
import { type Platform } from '../usePlatform';
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

// Phase 21 slice 4 (2026-05-06): URL mode -> initial platform for
// the new platform toggle. Falls through to 'note' when no mode is
// set or when the mode is 'self-pilot' (which doesn't map to a
// platform shape — self-pilot meant 'rail dormant', a different
// concept).
function platformFromMode(
  mode: GardenRailMode | undefined
): Platform | undefined {
  if (mode === 'newsletter') return 'newsletter';
  if (mode === 'linkedin') return 'linkedin';
  return undefined;
}

// Phase 22 slice 1 (2026-05-06): does the draft's contentJson
// have anything substantive in it? An empty draft is the doc shape
// Tiptap initializes with — { type: 'doc', content: [{ type:
// 'paragraph' }] } — or an empty / null contentJson. Anything
// else (including a single paragraph with text) counts as having
// content; the user is past the empty state.
function isDraftEmpty(content: unknown): boolean {
  if (!content) return true;
  if (typeof content !== 'object') return true;
  const doc = content as { content?: unknown[] };
  if (!doc.content || !Array.isArray(doc.content)) return true;
  if (doc.content.length === 0) return true;
  if (doc.content.length === 1) {
    const first = doc.content[0] as {
      type?: string;
      content?: unknown[];
    };
    if (
      first.type === 'paragraph' &&
      (!first.content || first.content.length === 0)
    ) {
      return true;
    }
  }
  return false;
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
      {/* Phase 21 slice 2 (2026-05-06): EditorShell wraps the route in
          the new 3-zone layout. Slice 3 fills the toolbar zone; slice
          4 wraps EditorPane in a platform-shaped visual frame; slice
          6 swaps EditorRightColumn for the new ChatCompanion. */}
      <EditorShell
        draftId={draft.id}
        initialPlatform={platformFromMode(mode)}
        initialIsEmpty={isDraftEmpty(draft.contentJson)}
        userName={user.name ? user.name.split(' ')[0] : null}
        chat={<ChatCompanion draftId={draft.id} />}
        artifactPanel={
          <ArtifactPanel
            toolbar={
              <EditorToolbar draftId={draft.id} title={draft.title} />
            }
            editor={
              <EditorPane
                draftId={draft.id}
                initialContent={draft.contentJson}
                initialVersion={draft.version}
                initialUpdatedAt={draft.updatedAt.toISOString()}
                title={draft.title}
                updatedAt={draft.updatedAt}
              />
            }
          />
        }
      />
    </EditorContextProvider>
  );
}
