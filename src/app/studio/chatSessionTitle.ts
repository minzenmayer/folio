// src/app/studio/chatSessionTitle.ts
//
// Phase 23 v2 slice 7 / fixed in slice 8.
//
// Title-from-topic helper. Cheap deterministic version: title-case the
// first phrase, truncate to ~50 chars on a word boundary, prefix with
// uppercase. Used at session-create time so the sidebar entry has a
// readable name immediately.
//
// Lives outside actions.ts because Next.js requires every export from
// a 'use server' file to be an async function. This is sync + pure;
// keeping it in a regular module lets it be imported from client
// components (HomeComposer.tsx) without server-action wrapping.

export function chatSessionTitleFromTopic(topic: string): string {
  const trimmed = topic.trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'Untitled';
  const cut = trimmed.slice(0, 50);
  const stop = cut.lastIndexOf(' ');
  const safe = trimmed.length > 50 && stop > 20 ? cut.slice(0, stop) : cut;
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}
