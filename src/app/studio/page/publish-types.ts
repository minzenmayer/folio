// Thoughtbed · Publish action result types
//
// Lives outside the 'use server' module because Next.js's RSC compiler
// gets confused when 'use server' files export types alongside async
// actions — the exported types' discriminator literals were being
// treated as client references. Moving them here is the canonical fix.

export type PublishToBeehiivResult =
  | {
      ok: true;
      postId: string;
      postUrl: string | null;
      title: string;
    }
  | {
      ok: false;
      reason:
        | 'no_connector'
        | 'connector_error'
        | 'no_publication'
        | 'empty_draft'
        | 'api_error';
      message: string;
    };
