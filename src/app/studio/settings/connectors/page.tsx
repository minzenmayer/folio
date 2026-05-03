// Thoughtbed · /studio/settings/connectors
//
// Sprint 14 brand pivot — settings became a modal overlay. The route
// stays alive as a deep-link target (e.g. for an email link or browser
// bookmark) and 308-redirects into /studio with the searchParam set.
// The SettingsModal in the parent layout reads ?settings=connectors and
// renders the panel.

import { redirect } from 'next/navigation';

export default function ConnectorsRouteRedirect() {
  redirect('/studio?settings=connectors');
}
