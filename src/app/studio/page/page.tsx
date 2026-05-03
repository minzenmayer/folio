// Thoughtbed · /studio/page — legacy index
// Sprint 10: the writing-first home moved up to /studio. The old empty-state
// "start a new draft" page here is now redundant — /studio already invites
// the user to write. Redirect to /studio rather than show a duplicate
// surface.
//
// /studio/page/[id] (the actual editor for a specific draft) is unchanged
// and remains the route the DraftsRail navigates between.

import { redirect } from 'next/navigation';

export default function PageIndex() {
  redirect('/studio');
}
