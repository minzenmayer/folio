// Thoughtbed · Page action result types
//
// These live OUTSIDE the 'use server' module. Next.js's RSC compiler
// gets confused when a 'use server' file exports types alongside async
// actions — the discriminator literals on the type unions get treated
// as client references at runtime, and any access to those references
// from server code throws "Cannot access <prop> on the server. You
// cannot dot into a temporary client reference from a server component."
//
// Phase 6 (commit 6bfa563) extracted PublishToBeehiivResult to
// publish-types.ts for exactly this reason. This file does the same for
// the three remaining inline types in page/actions.ts:
//   · UpdateDraftResult   — autosave result + conflict shape
//   · DraftVersionRow     — listDraftVersions row shape
//   · RestoreDraftResult  — restoreDraftVersion success shape
//
// On the very first save after the Clerk Production swap (2026-05-04),
// every keystroke debounce hit "Cannot access level on the server" —
// the same RSC violation, this time triggered through deriveTitle's
// node.attrs?.level access path while the action result was being
// shaped against UpdateDraftResult. Moving the types here is the
// canonical fix.

export type UpdateDraftResult =
  | {
      ok: true;
      savedAt: string;
      title: string | null;
      version: number;
    }
  | {
      ok: false;
      conflict: true;
      currentDoc: unknown;
      currentVersion: number;
      currentTitle: string | null;
      currentUpdatedAt: string;
    };

export type DraftVersionRow = {
  id: string;
  source: string;
  createdAt: string;
  contentJson: unknown;
};

export type RestoreDraftResult = {
  savedAt: string;
  title: string | null;
  version: number;
  content: unknown;
};
